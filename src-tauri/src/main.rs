// The console window on Windows is for a program someone runs at a prompt;
// Otto is a tray application.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    otto_lib::run()
}
