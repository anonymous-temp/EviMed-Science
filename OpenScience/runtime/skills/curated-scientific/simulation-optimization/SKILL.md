---
name: simulation-optimization
description: Build and validate mechanistic, discrete-event, stochastic, or multi-objective simulations and optimization studies. Use for SimPy, numerical simulation, sensitivity analysis, parameter calibration, design-space search, or Pareto optimization.
---

# Simulation and optimization

State the system boundary, entities, state variables, equations or events, time scale,
initial conditions, parameters, constraints, objective functions, and stopping rules.
Separate measured inputs, calibrated parameters, assumptions, and decision variables.
Check dimensions, conservation rules, limiting cases, and numerical stability.

Validate against analytic cases, observed data, or an independent implementation where
available. For stochastic models, use recorded seeds and enough replications to quantify
Monte Carlo error. For optimization, guard against leakage from evaluation data, report
constraint violations, show trade-offs rather than one cherry-picked solution, and test
sensitivity to uncertain inputs.

Produce `simulation-spec.md`, runnable code, machine-readable results, validation and
sensitivity plots, and a provenance manifest. Fail rather than returning an infeasible,
non-converged, or numerically unstable result as an optimum.

## Deterministic baseline

For a bounded executable baseline, prepare a JSON request or supported data file and run:

```bash
python "../_runtime/execute_skill.py" --skill simulation-optimization --input REQUEST.json --output-dir OUTPUT_DIR
```

Review `execution-receipt.json`, `results.json`, and the generated report before interpretation. The baseline is deliberately limited; when its report names an unsupported method or input, use the broader notebook workflow above and preserve the same provenance and failure boundaries.
