//! Native menu. Every Kemudi shortcut is a real menu item: on macOS a ⌘ key
//! with no menu item behind it isn't reliably delivered to the webview (⌘W
//! was swallowed). Item ids are emitted to the frontend as `menu` events and
//! run the same commands as its keyboard router (src/lib/keys.ts).

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Named explicitly: a dev build's binary is plain "kemudi".
    const NAME: &str = "Kemudi Devops";
    let app_menu = SubmenuBuilder::new(app, NAME)
        .about_with_text(
            format!("About {NAME}"),
            Some(AboutMetadata {
                name: Some(NAME.into()),
                ..AboutMetadata::default()
            }),
        )
        .separator()
        .item(&item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .item(&item(
            app,
            "passwords",
            "Passwords…",
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .item(&item(app, "environment", "Environment…", None)?)
        .separator()
        .services()
        .separator()
        .hide_with_text(format!("Hide {NAME}"))
        .hide_others()
        .show_all()
        .separator()
        .quit_with_text(format!("Quit {NAME}"))
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&item(app, "tab.new", "New Tab", Some("CmdOrCtrl+T"))?)
        .item(&item(
            app,
            "tab.ssh",
            "New SSH Tab…",
            Some("CmdOrCtrl+Shift+T"),
        )?)
        .separator()
        .item(&item(
            app,
            "tab.close",
            "Close Pane / Tab",
            Some("CmdOrCtrl+W"),
        )?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        // Our own Select All: in a terminal at a prompt it selects the command
        // being typed (the built-in one targets xterm's hidden textarea).
        .item(&item(
            app,
            "edit.selectAll",
            "Select All",
            Some("CmdOrCtrl+A"),
        )?)
        .separator()
        .item(&item(
            app,
            "vault.fill",
            "Fill Saved Password",
            Some("CmdOrCtrl+Shift+P"),
        )?)
        .separator()
        .item(&item(
            app,
            "block.copyCommand",
            "Copy Last Command",
            Some("CmdOrCtrl+Shift+C"),
        )?)
        .item(&item(
            app,
            "block.copyOutput",
            "Copy Last Output",
            Some("CmdOrCtrl+Alt+Shift+C"),
        )?)
        .separator()
        .item(&item(app, "find", "Find…", Some("CmdOrCtrl+F"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item(
            app,
            "palette",
            "Command Palette…",
            Some("CmdOrCtrl+K"),
        )?)
        .item(&item(app, "history", "History", Some("CmdOrCtrl+Y"))?)
        .item(&item(
            app,
            "panel.actions",
            "Show/Hide Actions",
            Some("CmdOrCtrl+J"),
        )?)
        .separator()
        .item(&item(
            app,
            "pane.splitRight",
            "Split Pane Right",
            Some("CmdOrCtrl+D"),
        )?)
        .item(&item(
            app,
            "pane.splitDown",
            "Split Pane Down",
            Some("CmdOrCtrl+Shift+D"),
        )?)
        .item(&item(
            app,
            "pane.left",
            "Focus Pane Left",
            Some("CmdOrCtrl+Alt+Left"),
        )?)
        .item(&item(
            app,
            "pane.right",
            "Focus Pane Right",
            Some("CmdOrCtrl+Alt+Right"),
        )?)
        .item(&item(
            app,
            "pane.up",
            "Focus Pane Above",
            Some("CmdOrCtrl+Alt+Up"),
        )?)
        .item(&item(
            app,
            "pane.down",
            "Focus Pane Below",
            Some("CmdOrCtrl+Alt+Down"),
        )?)
        .separator()
        .fullscreen()
        .build()?;

    let mut window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&item(
            app,
            "tab.prev",
            "Show Previous Tab",
            Some("CmdOrCtrl+Shift+["),
        )?)
        .item(&item(
            app,
            "tab.next",
            "Show Next Tab",
            Some("CmdOrCtrl+Shift+]"),
        )?)
        .separator();
    for n in 1..=9 {
        let label = if n == 9 {
            "Last Tab".to_string()
        } else {
            format!("Tab {n}")
        };
        window = window.item(&item(
            app,
            &format!("tab.{n}"),
            &label,
            Some(&format!("CmdOrCtrl+{n}")),
        )?);
    }

    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window.build()?])
        .build()
}
