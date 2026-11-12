// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--minimize-accessible-window") {
        let success = args
            .next()
            .and_then(|value| value.parse::<isize>().ok())
            .is_some_and(|hwnd| {
                aero_dock_lib::platform::windows::running::minimize_accessible_window(hwnd).is_ok()
            });
        std::process::exit(if success { 0 } else { 1 });
    }
    aero_dock_lib::run()
}
