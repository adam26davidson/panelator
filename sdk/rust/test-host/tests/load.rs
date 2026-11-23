//! Tests of the load rules of the document (modules written in WAT).

mod common;

use common::{DRAW_PIXEL, Wat, err};
use panelator_test_host::abi::update_due;
use panelator_test_host::host::{Instance, Setup};

#[test]
fn a_conforming_module_loads_and_reports_its_declarations() {
    let i = Wat::default().load().unwrap();
    assert_eq!(
        (
            i.info.abi_version,
            i.info.update_hz,
            i.info.width,
            i.info.height
        ),
        (1, 1, 64, 32)
    );
    assert_eq!(i.info.memory_pages, 1);
}

#[test]
fn a_different_major_or_a_greater_minor_fails_naming_both_versions() {
    for (v, text) in [
        (0x0001_0000, "1.0"),
        (0x0000_0002, "0.2"),
        (0x0002_0001, "2.1"),
    ] {
        let e = err(&Wat {
            version: v,
            ..Wat::default()
        });
        assert!(
            e.contains("abi version") && e.contains(text) && e.contains("0.1"),
            "{e}"
        );
    }
    assert!(
        Wat {
            version: 0,
            ..Wat::default()
        }
        .load()
        .is_ok(),
        "an older minor loads"
    );
}

#[test]
fn no_export_but_the_declarations_runs_before_the_version_is_accepted() {
    // A start-less module whose pn_init would trap if it ran: the version check comes first.
    let w = Wat {
        version: 0x0005_0000,
        init: "unreachable".into(),
        ..Wat::default()
    };
    assert!(err(&w).contains("5.0"));
}

#[test]
fn imports_are_checked_by_module_name_and_signature() {
    let e = err(&Wat {
        imports: r#"(import "env" "abort" (func))"#.into(),
        ..Wat::default()
    });
    assert!(e.contains("imports") && e.contains("env.abort"), "{e}");
    let e = err(&Wat {
        imports: r#"(import "panelator" "fetch_url" (func))"#.into(),
        ..Wat::default()
    });
    assert!(e.contains("panelator.fetch_url"), "{e}");
    let e = err(&Wat {
        imports: r#"(import "panelator" "draw_fill" (func (param i32 i32)))"#.into(),
        ..Wat::default()
    });
    assert!(
        e.contains("panelator.draw_fill") && e.contains("(i32,i32)->()"),
        "{e}"
    );
    let e = err(&Wat {
        imports: r#"(import "panelator" "memory" (memory 1))"#.into(),
        memory: String::new(),
        ..Wat::default()
    });
    assert!(e.contains("panelator.memory"), "{e}");
}

#[test]
fn exports_are_exactly_the_abi_with_its_signatures() {
    let e = err(&Wat {
        extra: r#"(func (export "helper"))"#.into(),
        ..Wat::default()
    });
    assert!(e.contains("exports") && e.contains("helper"), "{e}");
    let text = Wat::default().text().replace(
        r#"(func (export "pn_height") (result i32) (i32.const 32))"#,
        "",
    );
    let e = Instance::new(&wat::parse_str(text).unwrap(), Setup::minimal())
        .err()
        .unwrap()
        .to_string();
    assert!(e.contains("pn_height") && e.contains("missing"), "{e}");
    let text = Wat::default().text().replace(
        r#"(export "pn_update") (param i64)"#,
        r#"(export "pn_update") (param i32)"#,
    );
    let e = Instance::new(&wat::parse_str(text).unwrap(), Setup::minimal())
        .err()
        .unwrap()
        .to_string();
    assert!(e.contains("pn_update") && e.contains("(i32)->()"), "{e}");
    let e = err(&Wat {
        memory: "(memory 1)".into(),
        ..Wat::default()
    });
    assert!(e.contains("memory"), "{e}");
}

#[test]
fn memory_is_at_most_four_pages() {
    assert!(
        Wat {
            memory: "(memory (export \"memory\") 4)".into(),
            ..Wat::default()
        }
        .load()
        .is_ok()
    );
    let e = err(&Wat {
        memory: "(memory (export \"memory\") 5)".into(),
        ..Wat::default()
    });
    assert!(
        e.contains("memory") && e.contains('5') && e.contains('4'),
        "{e}"
    );
}

#[test]
fn memory_grow_past_the_limit_returns_minus_one() {
    let w = Wat {
        imports: DRAW_PIXEL.into(),
        init: r"(call $draw_pixel (i32.const 0) (i32.const 0) (memory.grow (i32.const 3)))
                 (call $draw_pixel (i32.const 1) (i32.const 0) (memory.grow (i32.const 1)))"
            .into(),
        ..Wat::default()
    };
    let mut i = Instance::new(
        &w.bytes(),
        Setup {
            width: 2,
            ..Setup::minimal()
        },
    )
    .unwrap();
    i.init(0, 0).unwrap();
    assert_eq!(
        i.layer().get(0, 0),
        Some(1),
        "growing from 1 page to 4 is allowed and returns the old size"
    );
    assert_eq!(
        i.layer().get(1, 0),
        Some(u32::MAX),
        "growing past 4 returns -1"
    );
}

#[test]
fn a_start_function_is_refused() {
    let e = err(&Wat {
        extra: "(func $s) (start $s)".into(),
        ..Wat::default()
    });
    assert!(e.contains("start function"), "{e}");
}

#[test]
fn forbidden_features_are_refused_by_name() {
    let e = err(&Wat {
        extra: "(func $t (result i32) (return_call $t))".into(),
        ..Wat::default()
    });
    assert!(e.contains("tail-call"), "{e}");
    let e = err(&Wat {
        extra: "(memory 1)".into(),
        ..Wat::default()
    });
    assert!(e.contains("multi-memory"), "{e}");
    let e = err(&Wat {
        memory: r#"(memory (export "memory") i64 1)"#.into(),
        ..Wat::default()
    });
    assert!(e.contains("memory64"), "{e}");
    let e = err(&Wat {
        extra: "(func (result v128) (v128.const i32x4 0 0 0 0))".into(),
        ..Wat::default()
    });
    assert!(e.contains("simd"), "{e}");
    let component = [0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0];
    let e = Instance::new(&component, Setup::minimal())
        .err()
        .unwrap()
        .to_string();
    assert!(e.contains("component"), "{e}");
}

#[test]
fn declarations_out_of_range_fail_the_load() {
    for (w, name) in [
        (
            Wat {
                hz: 61,
                ..Wat::default()
            },
            "pn_update_hz",
        ),
        (
            Wat {
                hz: -1,
                ..Wat::default()
            },
            "pn_update_hz",
        ),
        (
            Wat {
                width: 0,
                ..Wat::default()
            },
            "pn_width",
        ),
        (
            Wat {
                width: 4097,
                ..Wat::default()
            },
            "pn_width",
        ),
        (
            Wat {
                height: 0,
                ..Wat::default()
            },
            "pn_height",
        ),
        (
            Wat {
                height: 4097,
                ..Wat::default()
            },
            "pn_height",
        ),
    ] {
        assert!(err(&w).contains(name));
    }
    for ok in [0, 60] {
        assert!(
            Wat {
                hz: ok,
                ..Wat::default()
            }
            .load()
            .is_ok()
        );
    }
    assert!(
        Wat {
            width: 4096,
            height: 1,
            ..Wat::default()
        }
        .load()
        .is_ok()
    );
}

/// A module that draws a pixel at (tick, 0) on every update.
fn counting(hz: i32) -> Wat {
    Wat {
        hz,
        imports: DRAW_PIXEL.into(),
        update: "(call $draw_pixel (i32.wrap_i64 (local.get 0)) (i32.const 0) (i32.const 1))"
            .into(),
        ..Wat::default()
    }
}

#[test]
fn the_due_rule_calls_a_module_the_right_number_of_times_at_the_right_ticks() {
    for (hz, calls) in [(1, 2), (7, 14), (30, 60), (60, 120), (0, 1)] {
        let bytes = counting(hz).bytes();
        let mut i = Instance::new(
            &bytes,
            Setup {
                width: 120,
                height: 1,
                ..Setup::minimal()
            },
        )
        .unwrap();
        let mut ticks = vec![];
        for t in 0..120u64 {
            if update_due(u32::try_from(hz).unwrap(), t) {
                i.update(t, 0, 0).unwrap();
                ticks.push(t);
            }
        }
        assert_eq!(ticks.len(), calls, "hz {hz}");
        let drawn: Vec<u64> = (0..120u64)
            .filter(|t| i.layer().get(i64::try_from(*t).unwrap(), 0) == Some(1))
            .collect();
        assert_eq!(drawn, ticks, "hz {hz}");
        if hz == 1 {
            assert_eq!(ticks, [0, 60]);
        }
        if hz == 30 {
            assert!(ticks.iter().skip(1).all(|t| t % 2 == 0 || *t == 1) || ticks[1] == 2);
        }
        if hz == 7 {
            assert_eq!(&ticks[..4], [0, 9, 18, 26]);
        }
    }
}

#[test]
fn a_trap_and_a_fuel_overrun_are_errors() {
    let mut i = Wat {
        update: "unreachable".into(),
        ..Wat::default()
    }
    .load()
    .unwrap();
    assert!(i.update(0, 0, 0).is_err());
    let mut i = Wat {
        update: "(loop $l (br $l))".into(),
        ..Wat::default()
    }
    .load()
    .unwrap();
    let e = i.update(0, 0, 0).unwrap_err();
    assert!(e.to_lowercase().contains("fuel"), "{e}");
}
