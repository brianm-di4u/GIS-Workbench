//! gwb-run: the command-line runner (REG-150) as a console program. See gwb_sidecar::recipe_run.

fn main() -> std::process::ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::ExitCode::from(gwb_sidecar::recipe_run::main(&argv))
}
