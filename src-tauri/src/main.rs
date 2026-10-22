// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `claude mcp add kemudi -- <this binary> --mcp`: a stdio MCP server, no window.
    if std::env::args().any(|a| a == "--mcp") {
        kemudi_lib::mcp_bridge();
        return;
    }
    kemudi_lib::run()
}
