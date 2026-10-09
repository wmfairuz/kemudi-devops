# Kemudi Devops
Personal macOS app for running dev/ops work on remote servers: a sidebar of
servers, apps and one-click actions next to real terminal tabs. Actions open
(or type into) a visible terminal, so you can watch the output, hit Ctrl+C and
keep typing. It uses the system `ssh`, so `~/.ssh/config`, ProxyJump, keys
and ssh-agent work exactly as they do in your terminal.

No accounts, no cloud, no telemetry.

## Prerequisites

- macOS on Apple Silicon, Xcode command line tools
- Rust stable (`rustup`): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node 22+ and pnpm

## Run

```bash
pnpm install
pnpm tauri dev          # dev build with hot reload
pnpm tauri build        # release .app + .dmg in src-tauri/target/release/bundle/
```

## Checks

```bash
pnpm tsc --noEmit
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test -- --ignored   # machine-dependent PTY/login-env smoke test
# validate a servers.yaml without launching the app
cd src-tauri && KEMUDI_VALIDATE=~/.config/kemudi/servers.yaml cargo test validate_file -- --ignored --nocapture
# the .env read/write scripts need GNU coreutils: dump them, run in Ubuntu
mkdir -p /tmp/rf && cd src-tauri && KEMUDI_RF_OUT=/tmp/rf cargo test dump_scripts -- --ignored
docker run --rm -v /tmp/rf:/t:ro ubuntu:24.04 sh -c 'mkdir -p /srv/app && printf "A=1\nSECRET=x\n" > /srv/app/.env && sh /t/write.sh && cmp /srv/app/.env /t/expected.env && sh /t/stale.sh'
# (it also writes sup-*.sh / cron-*.sh: run them as a user with sudo, with
#  supervisord and cron installed, to check reread, restore and crontab -)
```

## How it works

- **Terminals**: xterm.js in the webview, `portable-pty` in Rust. PTY output
  streams as raw bytes over a Tauri Channel; input goes back through
  `pty_write`.
- **Environment**: Apps launched from Finder get launchd's bare PATH. At
  startup Kemudi runs your login shell once (`$SHELL -l -i`), captures its
  environment and uses it for every terminal, so `ssh`, `dep`, `php` and the
  agent behave as they do in Warp.
- **Look**: the whole window is Dracula-tinted and set in Menlo (like the
  terminal and Warp); terminal defaults to Menlo 14 with Warp-like spacing,
  overridable with `terminal: { font_family, font_size, line_height }`.
  Layout follows the Claude Design handoff in `design/`.
- **Keyboard**: every key except ⌘ chords goes to the terminal (Ctrl+C, Ctrl+R,
  Ctrl+D, Esc, arrows, Option-arrows). ⌘C/⌘V copy and paste.
- **Design**: `design/` holds the Claude Design handoff (`Kemudi.dc.html` is the
  board, `KemudiWindow.dc.html` the window component). Tokens live in
  `src/index.css`; design primitives in `src/components/kit/`.

## Configuration

Everything in the sidebar comes from `~/.config/kemudi/servers.yaml` (set
`KEMUDI_CONFIG=/path/to/file.yaml` to use another file). The first-run screen
has a **Create servers.yaml** button that writes a commented sample. The file
hot-reloads on save; if a save breaks it, Kemudi keeps the last good config
(marked STALE) and shows the error with its line number.

- **Servers and apps in the sidebar** (Querious-style rows with initials):
  **click** one for its details page in the main area (edit the fields, Save,
  **Open shell**, Delete…; a server's page lists its apps with + Add app),
  **double-click** to ssh straight in (into the app's path for an app),
  **right-click** for Details… / Add app… / Delete…. The **+** next to
  *Servers* adds one. Kemudi edits only the lines it must, keeps your
  comments, and checks the result before writing it; with no servers.yaml
  yet, the first server creates it.
- **Home tab** (pinned first; the start screen): New terminal, SSH to host,
  Add server; your tab configs (one click opens one), servers with status,
  SSH hosts (**New** creates one with Test connection; Kemudi's are
  editable and deletable; **Manage in Kemudi** moves one of your own Host
  blocks from ~/.ssh/config into Kemudi's file after a timestamped backup,
  keeping options it has no field for under *Other options*), recent runs (click to run again, asking first like a click),
  and links to Settings, History, Environment, servers.yaml, ~/.ssh/config.
- **Git remote per app** (`repo:`): on the app's page, **Detect** reads
  `git remote get-url origin` in the app's path over ssh (read-only), **Open ↗**
  opens it in the browser; usable as `{{ app.repo }}`. Credentials in a clone
  URL (`https://user:token@…`) are stripped and never saved.
- **Inspect** (app page ▸ On the server): a read-only look at the app's folder
  on the server: git branch and last commit, Laravel version, the Nginx/Apache
  vhost(s) and Supervisor programs that mention the path (with status, whole
  config files to show or copy), cron lines, and the .env (secrets hidden until
  clicked; copy one, selected or all entries; APP_DEBUG/APP_ENV warnings on
  prod). Files only root can read are retried with `sudo -n` (never prompts).
  Wildcard vhosts (root `…/$app/public`) are found by the app's parent folder
  and labelled *wildcard*; the link becomes the app's real host
  (`billing.staging.example.com`). Configs that don't name the path can be
  **pinned**: pick from the server's vhost / Supervisor files (saved as
  `vhost_files:` / `supervisor_files:`), and Inspect always reads them.
  *Use as branch* / *Use PHP x.y* fill the form. Each Supervisor program has
  **Restart** (`sudo supervisorctl restart '<name>:*'` as a built-in danger
  action: asks first, runs in a tab, recorded in History). The Web server
  section has **Test & reload nginx** (`sudo nginx -t && sudo systemctl reload
  nginx`) and **Restart nginx** (config test first, then `systemctl restart`);
  Apache gets the same with `apachectl configtest`. The last result is
  kept per app with an "Inspected 2h ago · 16:40" stamp. .env values whose
  key looks secret (`*PASS*`, `*KEY*`, `*TOKEN*`, `*SECRET*`, a URL with a
  password, …) are kept apart, encrypted (ChaCha20-Poly1305) in
  `~/Library/Application Support/kemudi/inspect-secrets.bin`; the one key is a
  Keychain item, "Kemudi Devops cache key" (delete it to make every cached
  secret unreadable). macOS asks for your Mac login password the first time
  (and a dev build again after each rebuild, as its signature changes): enter
  it and choose *Always Allow*. If the prompt is refused, Kemudi stops asking
  for that launch, keeps secrets in memory only, and the .env section offers
  **Try again**. (`KEMUDI_SECRET_CACHE=off` keeps secrets in memory only and
  never touches the Keychain, for a second test copy of the app.)
- **Edit .env** (Inspect ▸ .env ▸ Edit): a **Table** (change values, rename or
  remove keys, add new ones; secrets masked until you show them) or **Text**
  (CodeMirror). Edits change one line at a time, so comments, blank lines,
  order, `export` and inline `# comments` are kept. **Review changes** shows a
  diff and what changed by key name; on prod you type the server name to
  save. Saving writes only if the file is still what you opened (otherwise
  *changed on the server*: reload or copy your version), keeps a backup next
  to it (`.env.kemudi-YYYYmmdd-HHMMSS`, newest 5 kept), keeps its owner and
  mode, and uses sudo only if your ssh user can't write it (passwordless sudo
  only, for now). The content goes over ssh's stdin, never a command line.
  History records which keys changed, never values. If Laravel's config is
  cached, Kemudi offers **Re-cache config** (`artisan config:cache`), since
  .env changes do nothing until then; queue workers need a restart too.
- **Edit Supervisor and cron** (Inspect ▸ Supervisor ▸ a config's *Edit*;
  Inspect ▸ Cron ▸ *Edit* / *Add*): CodeMirror, diff review, conflict check,
  backups and prod's type-the-name, as for .env.
  - *Supervisor*: only `/etc/supervisor/…`, `/etc/supervisord.d/…` or a file
    pinned on an app. After saving, Kemudi runs `supervisorctl reread` and
    shows what it says; nothing restarts until **Apply** (`supervisorctl
    update`: only changed programs restart). If Supervisor can't read the new
    config, **Restore the backup** puts the old one back.
  - *Cron*: whichever crontab or `/etc/cron.d` file holds the app's lines
    (Inspect finds them; with none, your crontab or www-data's). Lines are
    checked as you type (5 time fields + command; + user in `/etc/crontab` and
    cron.d). A crontab is installed with `crontab -`, which rejects a bad file
    whole; its backup goes to `~/.kemudi-backups` (mode 600) on the server.
- **Edit a vhost** (Inspect ▸ Web server ▸ a vhost's *Edit*): nginx or Apache
  configs under `/etc/nginx`, `/etc/apache2`, `/etc/httpd` or pinned on an
  app. A symlink (sites-enabled → sites-available) is followed, so the link
  stays. Backups go to `~/.kemudi-backups` on the server, not next to the
  file (the web server would load a copy left in sites-enabled). Saving runs
  `nginx -t` / `apachectl configtest` before and after: if your change makes
  it fail, the old file goes straight back, nothing changed, and you're back
  in the editor with the error. If it was already failing before, the change
  stays and you're told. On success, **Reload now** (test & reload, with
  the usual confirm) or **Restore the backup**. A wildcard vhost shows a
  note that it serves every matching app.
- **Files** (server/app page ▸ *Files*, or right-click a server or app): a
  file explorer tab on the server, starting in the app's folder (or home).
  Folders that need root are listed with sudo (the saved sudo password
  works). Double-click a folder to open it, a file to open it in the editor
  (diff review, conflict check, backup in `~/.kemudi-backups`, prod confirm;
  text files up to 512 KB). Right-click: **Download** (with `scp`, to
  ~/Downloads or the folder set in Settings ▸ Files; through a sudo copy when
  only root can read it; *Show in Finder*), **Download to…** (picks a folder
  with the macOS folder dialog),
  **Copy path**, **Terminal here**, **Rename…** (F2; never over an existing
  name), **Delete…** (⌘⌫; a folder with everything inside, for good; a
  folder or anything on prod needs its name typed; the top two levels like
  /etc or /opt/www and an app's own folder are refused), **Change owner…** (`sudo chown [-R]
  owner:group`, suggesting the server's users and groups: root, logins and
  web/service accounts; prod asks for the server name; links change, never
  what they point to; recorded in History), **Change permissions…**
  (read/write/execute for owner, group, others or an octal mode like 2775;
  for a folder optionally everything inside, folders and files with their
  own modes, e.g. 775 / 664; as you when you own it, else sudo). The Owner
  column shows `owner:group`. When it can't (no sudo for this user, the
  saved password refused, a read-only file system…) it says why and
  nothing else changes. **Drop files from Finder** onto it to
  upload into the folder shown: it asks first, never replaces a file
  without asking, and uses sudo (owned like the folder) where needed.
  Uploads are recorded in History. **Copy / Cut** (⌘C / ⌘X or right-click)
  then **Paste** (⌘V or the toolbar's *Paste* button, in any Files tab on
  the same server; right-click a folder ▸ *Paste into*): `cp -a` (owners and
  modes kept) or `mv`, never over something that exists, with sudo where
  needed; moving never takes the top levels or an app's folder, and asks
  first. **Duplicate** makes "name copy" (then "name copy 2"…). **Find**
  (⌘F or the magnifier): by **name** (`*part*`, any case) or **contents**
  (text files, line and line number) under the folder shown, skipping
  vendor, node_modules and .git unless unticked; double-click a result to
  open it. Right-click a folder ▸ **Download as .tar.gz** (packed on the
  server, with sudo if needed) or **without vendor, node_modules, .git**
  (the top-level ones; `resources/views/vendor` stays). **New folder** (⇧⌘N) and **New file**
  (toolbar): made in the folder shown, never over an existing name, with
  sudo when needed (then owned like the folder); a new file opens in the
  editor. ⌫ goes up a folder.
- **Teams** (like DigitalOcean's): the switcher at the top of the sidebar
  picks the team in front, and the sidebar, Home, ⌘K and the Snippets list
  show only its servers / snippets (*All teams* shows everything, *No team*
  the servers without one). *New team…* / *Edit…* / *Delete…* from the same
  menu: a name, an ID and a colour (its initials badge, and the tab colour of
  its servers that set none). A server's page has a **Team** choice; a new
  server starts in the team in front. A team has its own **shared actions**:
  the Actions panel shows *All apps in <team>* and *All servers in <team>*
  next to the global shared lists (a team action with the same ID as a
  global one replaces it for that team's servers; right-click ▸ Delete for
  every app in <team> removes only the team's). **Snippets** can belong to a
  team (shown only there) or every team. Deleting a team keeps its servers,
  with no team. In servers.yaml: `teams: [{ id, name, color, actions: { app,
  server, local } }]` and `team:` on a server.
- **Discover apps** (server page ▸ *Apps on …* ▸ *Discover apps…*, or
  right-click a server): looks around the server (read-only) for Laravel
  apps: an `artisan` under /var/www, /opt, /srv, /home, following links
  (e.g. /opt/www → /mnt/…, Deployer's `current`; never `releases/`), and
  whatever nginx/Apache roots, Supervisor programs and cron lines point at;
  one per real folder. Each comes filled in: name (APP_NAME,
  else the folder), a free ID, path, branch and git remote (credentials left
  out), PHP version (see below), environment (only when
  APP_ENV says production, staging or QA and that differs from the server;
  `local` follows the server), its vhost and Supervisor files (pinned), and
  the domains it's served on (wildcard vhosts like `root
  /opt/www/x/$subdomain/public` included). Tick the ones you want, adjust
  names / IDs, *Add*. Apps already in Kemudi are listed as such.
- **New app** (server page ▸ *Apps on …* ▸ *New app…*, or right-click a
  server): sets up a Laravel app on the server and adds it to Kemudi. Kemudi
  first looks at the server (read-only): PHP versions, PHP-FPM sockets, the
  login user's public keys, how its other apps are owned, MySQL users and
  databases, Supervisor's folder, certificates. You fill in name, domain,
  APP_ENV, repository (*Check access* runs `git ls-remote` on the server with
  its own key and lists the branches; the key is shown to copy as a read-only
  deploy key, or created if there's none), branch, path (next to the
  server's other apps), PHP, owner (like the other apps), and pick:
  - database: a **new user** (password made on the server, written only to
    the app's .env), an **existing user** (you type its password in the
    terminal; goes only to .env), or skip; the database is created
    (utf8mb4) and granted if needed. When MySQL's root needs a password,
    the terminal asks for it (never saved);
  - web: a **wildcard vhost** already on the server (`server_name
    ~^(?<sub>[^.]+).example.com` + `root /x/$sub/public`; picked for you
    when it serves the folder the server's apps live in): the app goes in
    the subdomain's folder and needs no vhost. Kemudi itself never edits how
    such a vhost picks PHP; when it spots `if ($http_host = "…") { set
    $phpversion "8.4"; }` blocks in an included file (like
    php-versions.conf), it offers *Add as a hook…*: an **after hook** for
    the server that adds a block for each new app's site (only when its PHP
    isn't the default; `nginx -t`, file put back if that fails; reload). You
    see and can change it before it's saved. Or:
  - a new nginx vhost (Kemudi's standard Laravel vhost, as in *New vhost*), with
    HTTPS from **certbot** (run last; if it fails the app still works over
    http), an **existing certificate** (one covering the domain, wildcards
    too, is picked for you) or none;
  - a Supervisor **queue worker** (`queue:work`, N processes, as the owner);
  - migrations (+ seed), the **scheduler** (`/etc/cron.d/laravel-<id>`:
    `schedule:run` every minute as the owner; skipped if a cron entry for
    the folder already runs it), and `npm ci && npm run build` when npm is
    there;
  - **hooks**: your own shell for every new app on a server or a team
    (`new_app_before:` / `new_app_after:` in the config, edited from the
    form's *Hooks* section; written as `|-` blocks). *before* runs after the
    tool checks, before the clone; *after* runs last, in the app's folder;
    the team's first, then the server's. They're templates like actions
    (`{{ app.id }}`, `{{ app.path }}`, `{{ app.php }}`, `{{ app.url }}`,
    `{{ app.domain }}`, `{{ app.branch }}`, `{{ app.repo }}`,
    `{{ app.app_env }}`, `{{ app.owner }}`, `{{ server.* }}`; shell-quoted,
    `| raw` to opt out) and run in a subshell with `set -e`, with Kemudi's
    helpers (`$S` for sudo, `ok`/`note`/`warn`/`die`, `$DIR`, `$PHPBIN`,
    `$OWNER`). A failing hook stops the run; a re-run runs them again, so
    write them to be safe to repeat. They show in the step list and the
    script; the config check flags ones that don't render.

  The right side lists the steps; *Show script* shows the exact bash. *Set it
  up* runs that script in a terminal tab (production asks for the server
  name): check tools → clone → database → .env (from .env.example: APP_NAME,
  APP_ENV, APP_DEBUG, APP_URL, DB_*) → composer install (`--no-dev` for
  production) → chown/permissions (and git `safe.directory` when the login
  user isn't the owner) → key:generate, storage:link, migrate as the owner →
  vhost + `nginx -t` (removed again if it fails) + reload → worker +
  `supervisorctl update` → scheduler → certbot → after hooks (before hooks
  run right after the checks). Each step skips what's already done, so
  after fixing a failure, *Open the form* (from the toast) and run it again.
  When it ends with exit 0 the app is added to Kemudi with its path, branch,
  PHP, repo, URL, vhost and worker files. The run is in History.
- **URL** (app page ▸ URL; *Detect*, and in Discover): where the app is on
  the web. APP_URL when its vhost serves that name, else the name its vhost
  serves (from a wildcard vhost too); https when that vhost has TLS. Other
  names it answers on are offered to pick. *Open ↗* opens it in the browser,
  as does right-click an app ▸ *Open site*; usable in actions as
  `{{ app.url }}`.
- **PHP version** (app page ▸ PHP ▸ *Detect*, and in Discover): what the web
  server runs the app with: its vhost's PHP-FPM socket (`php8.4-fpm.sock`),
  or for `php$phpversion-fpm.sock` the `set $phpversion …` statements (in
  the vhost or a file it includes, with `if ($http_host = "…")` per site;
  the last one that applies wins) or an nginx `map` (`hostnames` patterns
  and `default` too), for the app's domains. Else its queue workers' or
  cron's `php8.x … artisan`, else the lowest installed PHP composer.json
  allows. It warns when they disagree (workers on another PHP than the site)
  or when composer.json needs a newer PHP than it gets.
- **Logs** (server/app page ▸ *Logs*, right-click a server or app, or
  double-click a `.log` file in Files): a live log viewer. An app's tab lists
  its `storage/logs` (also under `current/` or `shared/` for release-style
  deploys) and the queue workers' logs from its Supervisor programs; a
  server's adds every app plus nginx/Apache, PHP-FPM, Supervisor, syslog,
  auth, kern, MySQL, Redis and Let's Encrypt. A log is shown as one family:
  `laravel.log` with its daily files (`laravel-2026-10-09.log`) and
  rotations (`error.log.1`, `syslog-20261009`; `.gz` ones left out). It
  always reads the **newest** file, so it opens on today's daily file and
  moves on to tomorrow's by itself ("Now following …"), and notices
  rotations and truncation; the second menu pins an older file. Following
  asks for what's new every 2 s (4 s through sudo) while the tab is shown,
  by byte offset, so nothing is re-sent; more than 1 MB at once is skipped
  (and says so). Root-only logs are read with sudo (the saved sudo password
  works; one sudo per read, and it stops on the first refusal so a wrong
  password isn't retried). Entries, not lines: a Laravel error with its
  stack trace is one row (time, level, message, the file:line it came
  from, or its context dimmed); click to see all of it and copy it.
  nginx error/access (status → level), PHP-FPM, `queue:work` output and
  syslog are understood too. Filter by level (All / Info+ / Warn+ /
  Errors, with counts) or text (⌘F); *Load earlier* reads the part
  before; Pause, Clear (the view only), Download and *Open folder in Files*.
- **Queues** (app page ▸ *Queues*, or right-click an app): queue health,
  refreshed every 15 s while shown. **Workers**: the Supervisor programs that
  run this app (state, pid, uptime; *Restart* = `supervisorctl restart
  prog:*`), or plain / systemd `queue:work` processes. **Waiting** jobs per
  queue (database queues also show delayed and running), **Failed** jobs
  (newest 200: when, job, queue, error; click for the whole exception and
  payload; *Retry*, *Forget*, *Retry all*, *Flush…*) and whether the
  **scheduler** runs (`schedule:run` cron or `schedule:work`). *Restart
  workers* is `artisan queue:restart` (they finish their job first). Laravel
  itself is asked (a short PHP script that boots the app), so any queue or
  failed-job driver works. Artisan always runs as the owner of the app's
  `storage/` (e.g. www-data), never as root, so it can't leave root-owned
  logs or cache files behind. Production asks first, and *Retry all* /
  *Flush* need the server's name typed. Recorded in History.
  Supervisor configs are found the way Supervisor finds them (its
  `[include] files =`), including subfolders like `conf.d/<site>/*.conf`.
- **Health** (server page ▸ *Health*, or right-click a server): read-only
  checks. **SSL**: every name in the nginx/Apache vhosts (not `_`, regex or
  wildcard names), checked against the certificate actually served (from
  the server itself: `openssl s_client` to 127.0.0.1:443 with the name, no
  call from this Mac): days left, expiry, issuer, the app it serves, *wrong
  cert* when it isn't for that name, *renewed on disk* when the file is newer
  than what's served (reload the web server), and what renews them (certbot
  timer / cron / acme.sh). If certbot's last run failed it says so, with
  the reason from its log (e.g. `--manual` DNS-challenge certificates,
  which can't renew unattended). **System**: OS, kernel, uptime, pending
  updates (and security ones), reboot needed, the usual services and any
  failed unit. **Apps**: PHP and Laravel versions, APP_ENV, APP_DEBUG (red
  when on in production), and **composer audit** on request (known
  vulnerabilities in composer.lock; asks packagist from the server, as the
  app's owner, cache in /tmp/kemudi-composer-<owner>). Every 6 hours (and 2
  minutes after launch) reachable servers' certificates are checked in the
  background: one expiring within 14 days notifies once and puts a 🔒 badge
  (days left) on the server; Settings ▸ Monitoring ▸ SSL expiry alerts.
  **Let's Encrypt (certbot)** lists certbot's certificates (domains, days
  left, how they renew). One issued with a **manual DNS challenge** (e.g. a
  wildcard), which certbot's timer can't renew, gets **Renew…**: Kemudi
  starts certbot on the server (`certonly --manual --preferred-challenges
  dns --force-renewal`, same domains) with a small hook that waits at each
  challenge, shows the TXT record to add (name and value, with Copy), checks
  the domain's own nameservers with `dig` (and Google's resolver) until it's
  there, then lets certbot go on. Afterwards nginx (or Apache) is tested
  and reloaded, the hook is taken back out of the renewal config, and the
  temporary folder is removed. *Stop* cancels it and leaves the certificate
  as it was. Recorded in History.
- **Fine-tune** (server page ▸ *Fine-tune*, or right-click a server): looks
  at the server (read-only: CPUs, RAM, swap, load; each PHP-FPM version's
  pools, how big their workers are and how often they hit
  `pm.max_children`; OPcache and memory_limit; MySQL's buffer pool against
  its InnoDB data and max_connections against the busiest moment, logging in
  as root or with /etc/mysql/debian.cnf; nginx; the PHP files in the apps)
  and suggests settings, each with current → suggested and why. A memory
  plan keeps room for the system and other services, keeps what PHP-FPM has
  now (half again for a version that hit its limit), grows MySQL's buffer
  pool into what's left, and shares any spare room out; limits are only
  lowered when memory is really overcommitted. Covers `pm.max_children` (and
  spares that fit), `pm.max_requests`, OPcache (`max_accelerated_files` for
  the apps' file count, memory, interned strings), `memory_limit = -1`,
  MySQL, nginx (`worker_processes`, `worker_connections`, `gzip_types`,
  `server_tokens`), a swap file when there's none, `vm.swappiness`.
  Optional ones start unticked. **Apply**: every file is backed up first;
  php.ini changes go in `conf.d/99-kemudi.ini`, MySQL's in
  `99-kemudi.cnf` (and live when MySQL allows it, else at its next
  restart), sysctl in `/etc/sysctl.d/60-kemudi.conf`; pool files and
  nginx.conf are edited in place. PHP-FPM and nginx are tested
  (`php-fpm -t`, `nginx -t`) and reloaded, or put back if the test fails.
  Production needs the server's name typed. **Undo last tuning** restores
  every file, MySQL and sysctl value and removes a swap file it made, then
  tests and reloads (backups in /root/.kemudi-tune/). Recorded in History.
- **New vhost** (Inspect ▸ Web server ▸ *New vhost*; the main button when
  no vhost serves the app): a Laravel nginx vhost from a few choices:
  domains, file name, root (`<app>/public`), the PHP-FPM socket (found on the
  server, the app's PHP version picked), HTTPS (HTTP only, an existing Let's
  Encrypt certificate with an HTTP→HTTPS redirect, or certbot afterwards),
  upload limit and own log files. The config is shown live in CodeMirror and
  can be edited (*Regenerate* undoes that). Creating writes
  `sites-available/<name>` (root 644), links it into `sites-enabled` and runs
  `nginx -t`; if that fails both are removed again. An existing file is never
  replaced. Then **Reload nginx now** and, for certbot, **Get certificate**
  (`sudo certbot --nginx -d …` in a tab, as it may ask questions; DNS must
  point to the server).
- Edits follow symlinks for every file (e.g. a deployer `current/.env` →
  `shared/.env`), and backups made in the same second never collide.
- **SSH key** (server page): **Install on <host>** copies one of your public
  keys to the server with `ssh-copy-id -o RemoteCommand=none -i
  ~/.ssh/<key>.pub <host>` in a tab (it asks for the server's password once:
  the Fill chip works there; a key that's already there is skipped). Then
  **Test connection**. With no key yet, **Create a key** runs `ssh-keygen -t
  ed25519` in a tab. At an ssh password prompt in a server's tab the chip also
  offers **Use a key instead**.
- **Passwords** (Kemudi Devops ▸ **Passwords…** ⇧⌘K, Home ▸ Passwords, ⌘K):
  a list of saved passwords, each with a name, optional username and notes;
  **Generate** makes a random one, **Copy password** puts it on the
  clipboard (cleared after 45 s if it's still there). Saved passwords are
  never shown again. At any password prompt in any tab (`[sudo] password
  for …:`, `user@host's password:`, `Password:`, a key passphrase…) a chip
  offers **Fill <best match>** and **Other…**; ⌘⇧P opens the picker anytime
  (without a prompt in sight it asks twice, as the password would show on
  screen). Nothing is typed on its own; Rust types it into the tab, so the
  value never reaches the web view. An entry can be the **sudo password on**
  some servers: it's suggested first at their sudo prompts and used (via
  sudo's askpass, on ssh's stdin, never a command line) when saving
  root-owned files there. Encrypted in `vault.bin` with the one Keychain
  key; History records fills by name only. `KEMUDI_KEYCHAIN_SERVICE=…` gives
  a test copy its own Keychain item.
- **Server monitor**: right-click a server → **Monitor** (or the Monitor
  button on its page / Home) opens a monitor tab: CPU % with a 5-minute
  sparkline and load, memory and swap, each disk (amber ≥ 80%, red ≥ 90%),
  and the top 10 processes by CPU or by memory (click a PID to copy it; right-click a process, or its ⋯, to investigate: Details, Watch it live, Process tree, Open files & connections run in a shell pane under the monitor; Trace system calls… and Stop it… type `sudo strace`/`kill` there for you to confirm with ↵). Every
  5 s while visible, over
  your own SSH (keys/agent, one shared connection via ControlMaster, socket
  in ~/.ssh/kemudi-cm-*) by a read-only script: nothing installed, no sudo.
  Linux servers only; splits like any tab (⌘D next to it opens an ssh shell).
  Thresholds (amber / red): CPU 80/90%, memory 80/90%, disk 80/90%, swap
  50/80%, 1-minute load per core 1/2; a card turns amber/red with its worst
  metric.
- **Disk alerts** (Settings ▸ Monitoring, on by default): every 15 minutes
  Kemudi checks reachable servers' disks (read-only `df` over ssh) and sends a
  macOS notification once when one reaches 90%; the server gets a red ⚠ badge
  in the sidebar and on Home until it drops under 85%.
- **Tab configs** (Warp-style): the **⌄** next to **+** lists them; one click
  opens a named, coloured tab whose panes each start in a folder on this Mac
  and type their commands once the prompt is ready (e.g. pull/merge/push on
  the left, `ssh app -t 'sudo su'` on the right). Same TOML format as Warp:
  yours live in `~/.config/kemudi/tab_configs/`, and Warp's
  (`~/.warp/tab_configs/`) are listed too, read-only. *New tab config…* /
  *Edit tab configs…* edit them in a form (layout presets: 1 pane, side by
  side, stacked, 3 columns, 2×3 grid); editing a Warp one saves a Kemudi copy.
- **Tab colours**: right-click a tab for a colour (Red, Crimson, Maroon, Coral,
  Orange, Amber, Gold, Yellow, Brown, Lime, Green, Teal, Cyan, Blue, Indigo,
  Purple, Pink, Gray), rename, split or close. A server's or app's page has a
  *Tab colour* that new tabs for it start with (an app's wins over its
  server's); saved as `color:`.
- **SSH hosts without editing ~/.ssh/config by hand**: in a server's page,
  pick an existing SSH host (Kemudi shows what it resolves to) or type a new
  name and fill in Address, User, Port, Key and Jump host. New hosts go to
  `~/.ssh/config.d/kemudi.conf` (mode 600), which `~/.ssh/config` includes
  with one line added at the top (the original is backed up once to
  `~/.ssh/config.kemudi-backup`), so `ssh <name>` works in any terminal.
  A host from your own ~/.ssh/config shows its Address, User, Port, Key and
  Jump host filled in from its `Host` block; change one and save, and Kemudi
  moves that block into its own file (your config backed up first to
  `~/.ssh/config.kemudi-backup-<time>`) with the change, so `ssh <name>`
  keeps working everywhere. A block it can't move (a `Host` line naming
  several hosts, an Include in it, a host from an included file) is shown
  read-only with the reason.
  **Test connection** tries a non-interactive login and says what's wrong.
  Passwords are never stored: a password-only server asks in the terminal.
- `servers[].host` is an `~/.ssh/config` alias (or `user@host`).
- Hosts with a `RemoteCommand` in ~/.ssh/config (e.g. `sudo -i`): ssh won't
  combine it with a command, so Kemudi's read-only commands (monitor, disk
  checks, Detect, Test connection) skip it; shells and actions on a host whose
  RemoteCommand is `sudo …` run as root through `sudo -H bash -lc` instead
  (keeping the intent); with any other RemoteCommand the ssh button logs in
  plainly so it runs, and actions skip it.
- **Actions panel (right, ⌘J)** shows the buttons for the app or server
  selected on the left, grouped: *Only this app*, *All apps* (shared),
  *Only this server*, *All servers* (shared). Each group's **+** adds an
  action there (name, command, on the server or this Mac, danger). Shared
  actions can be hidden on one app (*Hidden here* lists them, with Show).
- **Snippets** (the panel's second tab): commands you use often, each with a
  name and optional notes, saved to `~/.config/kemudi/snippets.yaml` (plain
  text: no passwords). Click one to see it; **Insert** types it at the prompt
  of the terminal in front without pressing ↵ (several lines go in as one
  paste), **Run** also presses ↵ (asks first in a production tab), plus Copy,
  Edit, **Duplicate** (a new snippet starting as a copy) and Delete. **Make action…** opens Add action with its name and command
  filled in, letting you pick where it goes (this app, all apps, this server,
  all servers) and optionally delete the snippet. Right-click a command in a
  terminal ▸ *Save command as snippet…*; ⌘K finds snippets by name, command or
  notes (↵ inserts).
- **Running an action in the shell you're in**: when the tab in front is an
  idle shell on the action's server (for an app's action: that app's shell,
  e.g. its *ssh* button), the action is typed at that prompt instead of
  opening a tab (same guardrails, recorded in History like *Send to current
  tab*); the tab keeps its name and stays your shell.
- **Running an action again**: if its tab from the last run is still open
  and idle at the shell prompt, the command runs there again (typed at the
  prompt, recorded in History like *Send to current tab*), keeping the
  scrollback and whatever you did in that shell since; the tab's ✓/✗ follows
  the new run. Otherwise (still running, closed, or no shell integration) it
  opens a new tab. After an action the tab stays a live shell, also after
  commands that run an interactive `bash -lic …` (deploy aliases), and
  Ctrl+C stops just the command.
- **Right-click an action button** for Run, **Edit… (name and command)**,
  **Duplicate…** (Add action filled in with "<name> copy", its command as
  written and its danger mark, starting where the original lives; pick
  another place if you like), how much it
  asks before running, **Mark as danger** (the red ◆; for this app/server only),
  **Delete** / **Reset to the shared one** / **Hide**. Edit command changes what the button runs and
  saves it (validated first; nothing runs). When the command
  comes from the shared global `actions:` entry you choose: only this app
  (Kemudi adds an override) or everywhere.
- **servers.yaml stays out of sight**: everything is edited in the UI, and
  the app never names the file. Only if it gets broken by hand does the
  sidebar show "Settings file, line N: …" with **Open at line N** (Sublime
  Text, VS Code or PhpStorm, whichever is installed first; `editor:` in the
  file chooses).
- The **ssh** button on a server opens a shell there; on an app it opens the
  shell already `cd`'d into the app's `path`.
- An app's `branch` and `php` are optional in the sample templates: without
  them Git pull runs `git pull` on the current branch and PHP is plain `php`.
- **Environments** `prod | staging | qa | dev` (QA in teal). A server has
  one, and each app can set its own (app page ▸ Environment; default: the
  server's), e.g. a staging app on a production server. An app's actions,
  .env, cron and shell tab follow the app's; what touches the whole server
  (its ssh tab, vhosts, Supervisor, server actions, nginx/Supervisor/certbot
  built-ins) follows the server's, so a server should be at least as strict
  as its strictest app (its page says so otherwise). The sidebar tags an app
  whose environment differs; templates get `{{ app.env }}` next to
  `{{ server.env }}`.
- `env: prod | staging | qa | dev`; `vpn: none | openfortivpn | globalprotect`
  (VPN servers need `vpn_check: { host, port }`; openfortivpn needs `vpn_connect`).
- `actions.app` / `actions.server` run over SSH; `actions.local` run on this Mac.
- Per-server or per-app `actions:` lists override by `id`
  (`{ id: migrate, disabled: true }`, or a new `{ id, label, run, danger, local }`).
- Templates use `{{ server.* }}` and `{{ app.* }}` (plus `app.vars`). Undefined
  variables are errors; values are shell-quoted automatically (`| raw` to opt out).
- Any other top-level name is a **parameter**, asked for when the action runs:
  `nc -vz -w 5 {{ ip }} {{ port }}` opens a small form for `ip` and `port`, with
  the command shown live underneath, then goes through the usual preview/confirm
  rules. `{{ port | default('22') }}` or `{% if tag is defined %}` makes one
  optional. The last values are remembered per action (not ones whose name
  contains pass/secret/token/key); the palette shows `<ip>` placeholders.
  A command with a placeholder left in never runs.

Action tabs run `ssh -t <host> '<command>; …marker…; exec $SHELL -l'`, so the
tab stays a live shell afterwards and Ctrl+C stops the command, not the tab.
⌥-click runs a one-off edit: the confirm dialog opens with the command ready
to change for this run only (servers.yaml is untouched), whatever the
confirmation level; in the staging/dev dialog ⌘↵ runs and ⌥↵ types it into
the current tab.

## Guardrails

Each action has a confirmation level, set per action with `confirm:` or with
the toggle in its confirm dialog / right-click menu (which edits servers.yaml):

| `confirm:` | a click… |
|---|---|
| `none` | runs (⌥-click still lets you edit first) |
| `warn` | shows the full command; one click to run |
| `type` | shows the command; type the server name to run |

Without `confirm:`, the default is: prod + `danger` → `type`, prod or
`danger` → `warn`, otherwise `none`.

- **Reachability**: each server's dot is a 2 s TCP probe, every 30 s, on window
  focus, and when you click the dot. Target: `vpn_check`, else `check`, else what
  `ssh -G <alias>` resolves (the first ProxyJump hop if any).
- **VPN gate**: SSH actions on a server with `vpn:` set probe first (in the UI
  and again in the backend). If it's down you get Retry / Connect VPN;
  openfortivpn's `vpn_connect` runs in a local tab so sudo can prompt.
- **Audit log**: every run (server, app, action, exact command, edited flag,
  exit code when detectable) goes to SQLite at
  `~/Library/Application Support/kemudi/audit.db` (`KEMUDI_DATA_DIR` overrides).
  ⌘Y opens History: search, filter, Re-run (through the same guardrails).

## Polish

- **Notifications**: an action that runs longer than 10 s and finishes while
  its tab isn't in front (or Kemudi isn't focused) posts a macOS notification.
- **Restore**: window size/position and open tabs come back on launch. Tabs
  reconnect only when you first look at them, and action tabs return as plain
  shells: nothing is ever re-run.
- **Flaky networks**: unless your ssh config sets its own, Kemudi's ssh gives
  up on a connect after 5 s and retries on a fresh connection (up to 8
  times), and shares one connection per host (`ControlMaster`, socket
  `~/.ssh/kemudi-cm-*`, kept 2 min after the last tab closes; keepalive every
  15 s). Once a host is connected, new panes, actions, Inspect and Monitor
  reuse it, so they open instantly. Some routes drop a share of new
  connections outright, and without this ssh would wait ~75 s and fail.
- **Reconnect**: when a shell or ssh tab's process ends (you typed `exit`, the
  connection dropped or timed out), press ↵ in it to start it again in place.
  Action tabs don't do this, since that would re-run the action.

## Command blocks

Like Warp, every command and its output form a block: right-click in a
terminal for **Copy command**, **Copy output**, **Copy command and output**,
**Select output**; ⇧⌘C / ⌥⇧⌘C copy the last command / output. Failed commands
get a red bar. This uses shell integration (OSC 133) without touching your
dotfiles: local zsh loads your own startup files through a Kemudi `ZDOTDIR`,
and remote shells start bash with a temporary rcfile that sources your
profile and deletes itself. Turn it off with `terminal: { shell_integration: false }`.

At a prompt, **click anywhere in the command you're typing** to put the cursor
there (Kemudi sends the shell ←/→ presses, so it works in zsh and bash, local
or over SSH). Clicking past the end goes to the end without accepting a grey
zsh-autosuggestion. Drag still selects text; full-screen apps (vim, htop) get
their clicks as usual.

It edits like a text field too: **⌘A** selects the command you're typing
(anywhere else, the whole terminal), and with part of the command selected,
typing or Backspace replaces it, **⌘V** pastes over it and **⌘X** cuts it.
**⌘C** copies any selection.

## Development note

`pnpm tauri dev` runs the app through `src-tauri/scripts/dev-sign-run.sh`
(set in `src-tauri/.cargo/config.toml`), which signs each dev build with
your Apple Development identity and the fixed identifier `dev.kemudi.app`.
Unsigned dev builds get a new code signature on every rebuild, so macOS
asked again for Keychain access each time; signed, *Always Allow* sticks.
`KEMUDI_SIGN_IDENTITY="…"` picks another identity, `=none` skips signing.

A second copy for testing next to your real one:
`open -n --env KEMUDI_QUIET=1 --env KEMUDI_DATA_DIR=/tmp/k --env
KEMUDI_KEYCHAIN_SERVICE=dev.kemudi.app.test "…/Kemudi Devops.app"`.
`KEMUDI_QUIET` turns off background checks and notifications (disk alerts),
`KEMUDI_DATA_DIR` keeps its History/session/vault apart, and
`KEMUDI_KEYCHAIN_SERVICE` gives it its own Keychain item (no password prompt
for the real one).

In `pnpm tauri dev`, editing a store file (`src/stores/*`) or anything it
imports reloads the whole page instead of hot-swapping it: a hot-swapped store
would be a second, empty copy that shortcuts and menus keep using (⌘W and ⌘A
would seem to stop working). Tabs come back through session restore.

## Shortcuts

| Keys | Action |
|---|---|
| ⌘K | Command palette: actions, apps, servers, tabs, commands (`pull akaun stg`); ↵ runs, ⌘↵ edits first |
| ⌘T | New local shell tab |
| ⇧⌘T | SSH to a host alias from `~/.ssh/config` |
| ⌘W | Close the pane (the tab goes with its last pane) |
| ⌘1–8, ⌘9 | Go to tab n, last tab |
| ⇧⌘[ / ⇧⌘] | Previous / next tab |
| ⌘F | Find in terminal |
| ⌘A | Select the command being typed (else everything) |
| ⌘J | Show/hide the Actions panel |
| ⌘⇧P | Fill a saved password (picker) |
| ⇧⌘K | Passwords |
| ⌘D / ⇧⌘D | Split the pane right / down (same server and folder; an action pane gives a shell there) |
| ⌥⌘ ← → ↑ ↓ | Move between panes |
| ⇧⌘C / ⌥⇧⌘C | Copy last command / its output |
| ⌘, | Settings (terminal font, size, line height, scrollback, ⌥ as Meta, shell integration, editor) |
| ⌘Y | History |
| / | Focus the sidebar filter |
| double-click tab | Rename; middle-click closes |
| Kemudi ▸ Environment… | PATH, ssh-agent and tools the terminals see |

## Status

- [x] M1 Scaffold + one local terminal
- [x] M2 Tabs + SSH (in the Claude Design look)
- [x] M3 Config, sidebar, actions
- [x] M4 Guardrails (prod confirmations, VPN preflight, audit log, History)
- [x] M5 ⌘K palette + polish (notifications, window + tab restore)
- [x] M6 Nginx vhost generator
- [x] Log viewer (follows the newest daily / rotated file)
- [x] Queue health (workers, waiting and failed jobs, scheduler)
- [x] File actions: copy / cut / paste, duplicate, find by name or contents, download a folder (.tar.gz)
- [x] Health checks: SSL expiry (what nginx actually serves), OS updates and reboot needed, services, APP_DEBUG on production, PHP / Laravel versions, `composer audit` on demand
- [x] Server fine-tuning: suggest settings from the server's RAM / CPUs and current load (PHP-FPM `pm.*` and `memory_limit`, OPcache, MySQL `innodb_buffer_pool_size` / connections, nginx workers / `client_max_body_size`, swap, `sysctl` like `vm.swappiness`), show current vs suggested with why, apply with a backup and a test (`nginx -t`, `php-fpm -t`) and roll back
- [ ] Git-pull deploy with a preview (incoming commits, migrations, composer.lock) and one-click rollback to the previous commit
- [ ] Run a command on several servers at once (one pane each, ✓/✗ summary)
- [ ] Claude button (parked)
