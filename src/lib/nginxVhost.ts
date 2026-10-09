// A new nginx vhost for a Laravel app: the config Laravel's deployment docs
// recommend, with the PHP-FPM socket, HTTPS and limits filled in.

export type HttpsMode = "none" | "cert" | "certbot";

export interface VhostOptions {
  /** server_name; the first is the main one. */
  domains: string[];
  /** Document root (the app's `public`). */
  root: string;
  /** e.g. /run/php/php8.4-fpm.sock */
  phpSocket: string;
  https: HttpsMode;
  /** Let's Encrypt certificate name (`https: "cert"`). */
  certName: string;
  /** certbot's options-ssl-nginx.conf + ssl-dhparams.pem exist. */
  certbotOptions: boolean;
  /** client_max_body_size, e.g. "64M" ("" leaves nginx's 1M). */
  maxBody: string;
  /** Per-site access/error logs named after `logName`. */
  logs: boolean;
  logName: string;
}

export const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
export const SITE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Problems that stop it from being created. */
export function vhostProblems(o: VhostOptions, existing: string[], name: string): string[] {
  const out: string[] = [];
  if (o.domains.length === 0) out.push("Add at least one domain.");
  for (const d of o.domains) if (!DOMAIN.test(d)) out.push(`“${d}” isn't a domain name.`);
  if (!o.root.startsWith("/") || /\s/.test(o.root)) out.push("The root must be a full path without spaces.");
  if (!o.phpSocket.startsWith("/")) out.push("Pick a PHP-FPM socket.");
  if (o.https === "cert" && !o.certName) out.push("Pick the certificate to use.");
  if (o.https === "certbot" && o.domains.some((d) => d.startsWith("*."))) out.push("certbot --nginx can't get a wildcard certificate.");
  if (o.maxBody && !/^\d+[kKmMgG]?$/.test(o.maxBody)) out.push("Upload limit looks like 64M.");
  if (!SITE_NAME.test(name)) out.push("The file name can use letters, digits, . _ -");
  else if (existing.includes(name)) out.push(`${name} already exists in sites-available: edit it from Inspect instead.`);
  return out;
}

function laravelBody(o: VhostOptions): string[] {
  const lines = [
    `    root ${o.root};`,
    "",
    '    add_header X-Frame-Options "SAMEORIGIN";',
    '    add_header X-Content-Type-Options "nosniff";',
    "",
    "    index index.php;",
    "    charset utf-8;",
  ];
  if (o.maxBody) lines.push(`    client_max_body_size ${o.maxBody};`);
  if (o.logs) {
    lines.push("", `    access_log /var/log/nginx/${o.logName}.access.log;`, `    error_log /var/log/nginx/${o.logName}.error.log;`);
  }
  lines.push(
    "",
    "    location / {",
    "        try_files $uri $uri/ /index.php?$query_string;",
    "    }",
    "",
    "    location = /favicon.ico { access_log off; log_not_found off; }",
    "    location = /robots.txt  { access_log off; log_not_found off; }",
    "",
    "    error_page 404 /index.php;",
    "",
    "    location ~ ^/index\\.php(/|$) {",
    `        fastcgi_pass unix:${o.phpSocket};`,
    "        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;",
    "        include fastcgi_params;",
    "        fastcgi_hide_header X-Powered-By;",
    "    }",
    "",
    "    location ~ /\\.(?!well-known).* {",
    "        deny all;",
    "    }",
  );
  return lines;
}

export function generateVhost(o: VhostOptions): string {
  const names = o.domains.join(" ");
  if (o.https !== "cert") {
    // Plain HTTP (certbot --nginx adds HTTPS to this block later).
    return ["server {", "    listen 80;", "    listen [::]:80;", `    server_name ${names};`, ...laravelBody(o), "}", ""].join("\n");
  }
  const live = `/etc/letsencrypt/live/${o.certName}`;
  const ssl = [`    ssl_certificate ${live}/fullchain.pem;`, `    ssl_certificate_key ${live}/privkey.pem;`];
  if (o.certbotOptions) ssl.push("    include /etc/letsencrypt/options-ssl-nginx.conf;", "    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;");
  return [
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${names};`,
    "    return 301 https://$host$request_uri;",
    "}",
    "",
    "server {",
    "    listen 443 ssl http2;",
    "    listen [::]:443 ssl http2;",
    `    server_name ${names};`,
    "",
    ...ssl,
    "",
    ...laravelBody(o),
    "}",
    "",
  ].join("\n");
}

/** The PHP-FPM socket for a PHP version (8.4 → …/php8.4-fpm.sock), else the
 *  first one found. */
export function socketFor(sockets: string[], php: string | null): string {
  return (php && sockets.find((s) => s.endsWith(`/php${php}-fpm.sock`))) || sockets.find((s) => /php[\d.]+-fpm\.sock$/.test(s)) || sockets[0] || "";
}
