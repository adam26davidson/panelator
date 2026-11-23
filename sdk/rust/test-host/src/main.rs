//! `panelator-test-host run|check|inspect`; see `sdk/conformance/README.md`.

use std::path::PathBuf;
use std::process::ExitCode;

use panelator_test_host::host::DEFAULT_FUEL;
use panelator_test_host::tool;

const USAGE: &str = "usage:
  panelator-test-host run <scene> --modules <dir> --out <dir> [--fuel <n>]
  panelator-test-host check <scene> --modules <dir> --golden <dir> [--actual <dir>] [--fuel <n>]
  panelator-test-host inspect <module>";

struct Args {
    positional: Option<String>,
    flags: Vec<(String, String)>,
}

impl Args {
    fn parse(args: &[String]) -> Result<Args, String> {
        let (mut positional, mut flags) = (None, vec![]);
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if let Some(name) = a.strip_prefix("--") {
                let v = it.next().ok_or(format!("--{name} needs a value"))?;
                flags.push((name.to_string(), v.clone()));
            } else if positional.is_none() {
                positional = Some(a.clone());
            } else {
                return Err(format!("unexpected argument {a}"));
            }
        }
        Ok(Args { positional, flags })
    }

    fn flag(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .find(|f| f.0 == name)
            .map(|f| f.1.as_str())
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        self.flag(name)
            .map(PathBuf::from)
            .ok_or(format!("--{name} is required"))
    }

    fn fuel(&self) -> Result<u64, String> {
        self.flag("fuel").map_or(Ok(DEFAULT_FUEL), |v| {
            v.parse().map_err(|_| format!("--fuel {v} is not a number"))
        })
    }
}

fn real_main(args: &[String]) -> Result<bool, String> {
    let command = args.first().ok_or(USAGE)?;
    let a = Args::parse(&args[1..])?;
    let target = PathBuf::from(a.positional.clone().ok_or(USAGE)?);
    match command.as_str() {
        "run" => {
            tool::run_to_dir(&target, &a.path("modules")?, &a.path("out")?, a.fuel()?)?;
            Ok(true)
        }
        "check" => {
            let actual = a.flag("actual").map(PathBuf::from);
            let c = tool::check(
                &target,
                &a.path("modules")?,
                &a.path("golden")?,
                actual.as_deref(),
                a.fuel()?,
            )?;
            if !c.ok {
                eprintln!("{}", c.report);
            }
            Ok(c.ok)
        }
        "inspect" => {
            let bytes = std::fs::read(&target).map_err(|e| format!("{}: {e}", target.display()))?;
            print!("{}", tool::inspect(&bytes));
            Ok(true)
        }
        _ => Err(USAGE.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match real_main(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(2)
        }
    }
}
