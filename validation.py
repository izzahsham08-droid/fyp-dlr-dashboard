"""
validation.py
=============
Validates the IEEE 738 DLR model against:
  1. Sensor DLR (measured)
  2. DLR Forecast (dlrf_24hr)
  3. Static Line Rating (SLR = 1434 A)

Produces validation metrics and prints a report.
Run AFTER dlr_model.py has generated dlr_results_2021.csv.
"""

import pandas as pd
import numpy as np


# ──────────────────────────────────────────
# LOAD RESULTS
# ──────────────────────────────────────────
def load_results(path='dlr_results_2021.csv'):
    df = pd.read_csv(path, parse_dates=['datetime'])
    return df


# ──────────────────────────────────────────
# METRICS
# ──────────────────────────────────────────
def metrics(actual, predicted, label=''):
    """Returns MAE, RMSE, MAPE, and Pearson r."""
    mask = ~(np.isnan(actual) | np.isnan(predicted))
    a, p = actual[mask], predicted[mask]
    n    = len(a)
    mae  = np.mean(np.abs(a - p))
    rmse = np.sqrt(np.mean((a - p)**2))
    mape = np.mean(np.abs((a - p) / a)) * 100
    r    = np.corrcoef(a, p)[0, 1]
    if label:
        print(f"\n  ── {label} (n={n}) ──")
        print(f"     MAE  : {mae:.2f} A")
        print(f"     RMSE : {rmse:.2f} A")
        print(f"     MAPE : {mape:.2f} %")
        print(f"     r    : {r:.4f}")
    return dict(mae=mae, rmse=rmse, mape=mape, r=r, n=n)


# ──────────────────────────────────────────
# MAIN VALIDATION REPORT
# ──────────────────────────────────────────
def run_validation(path='dlr_results_2021.csv'):
    df  = load_results(path)
    SLR = 1434

    print("=" * 55)
    print("  DLR MODEL VALIDATION REPORT")
    print("  IEEE Std 738-2012 | SLR = 1434 A | HW threshold = 32°C")
    print("=" * 55)

    # ── 1. Calculated DLR vs Sensor DLR ───────────────────────
    print("\n[1] IEEE 738 Calculated DLR vs Sensor DLR")
    m1 = metrics(df['dlr'].values, df['dlr_calculated'].values,
                 'All periods')

    hw  = df[df['is_heatwave'] == 1]
    nrm = df[df['is_heatwave'] == 0]
    metrics(nrm['dlr'].values, nrm['dlr_calculated'].values, 'Normal periods')
    metrics(hw['dlr'].values,  hw['dlr_calculated'].values,  'Heatwave periods (Ta≥32°C)')

    # ── 2. Calculated DLR vs Forecast DLR ─────────────────────
    print("\n[2] IEEE 738 Calculated DLR vs DLR Forecast (dlrf_24hr)")
    metrics(df['dlr_forecast'].values, df['dlr_calculated'].values,
            'Calculated vs Forecast')

    # ── 3. Sensor DLR vs SLR ──────────────────────────────────
    print("\n[3] Sensor DLR vs SLR (1434 A)")
    valid = df['dlr'].dropna()
    above = (valid > SLR).sum()
    below = (valid < SLR).sum()
    print(f"\n  ── All periods (n={len(valid)}) ──")
    print(f"     Hours sensor DLR > SLR : {above}  ({100*above/len(valid):.1f}%)")
    print(f"     Hours sensor DLR < SLR : {below}  ({100*below/len(valid):.1f}%)")
    print(f"     Mean sensor DLR        : {valid.mean():.1f} A")
    print(f"     Min  sensor DLR        : {valid.min():.1f} A")
    print(f"     Max  sensor DLR        : {valid.max():.1f} A")

    # ── 4. Heatwave impact ─────────────────────────────────────
    print("\n[4] Heatwave impact on DLR")
    print(f"\n  Normal periods  (Ta < 32°C)  — n={len(nrm)}")
    print(f"     Mean DLR calculated : {nrm['dlr_calculated'].mean():.1f} A")
    print(f"     Mean DLR sensor     : {nrm['dlr'].mean():.1f} A")
    print(f"     Mean DLR forecast   : {nrm['dlr_forecast'].mean():.1f} A")
    print(f"     SLR                 : {SLR} A")
    print(f"     DLR calc vs SLR     : {nrm['dlr_calculated'].mean()-SLR:+.1f} A")

    print(f"\n  Heatwave periods (Ta ≥ 32°C) — n={len(hw)}")
    print(f"     Mean DLR calculated : {hw['dlr_calculated'].mean():.1f} A")
    print(f"     Mean DLR sensor     : {hw['dlr'].mean():.1f} A")
    print(f"     Mean DLR forecast   : {hw['dlr_forecast'].mean():.1f} A")
    print(f"     SLR                 : {SLR} A")
    print(f"     DLR calc vs SLR     : {hw['dlr_calculated'].mean()-SLR:+.1f} A")

    reduction = nrm['dlr_calculated'].mean() - hw['dlr_calculated'].mean()
    pct       = reduction / nrm['dlr_calculated'].mean() * 100
    print(f"\n  DLR reduction in heatwave vs normal: {reduction:.1f} A  ({pct:.1f}%)")

    # ── 5. Monthly summary ─────────────────────────────────────
    print("\n[5] Monthly DLR Summary")
    months = ['Jan','Feb','Mar','Apr','May','Jun',
              'Jul','Aug','Sep','Oct','Nov','Dec']
    monthly = df.groupby('month').agg(
        dlr_calc_mean  = ('dlr_calculated','mean'),
        dlr_sensor_mean= ('dlr','mean'),
        ta_mean        = ('Ta','mean'),
        heatwave_hrs   = ('is_heatwave','sum')
    ).round(1)
    monthly.index = months
    print(f"\n  {'Month':<6} {'DLR calc':>10} {'DLR sensor':>12} {'Ta mean':>9} {'HW hrs':>8}")
    print(f"  {'':─<6} {'':─>10} {'':─>12} {'':─>9} {'':─>8}")
    for m, row in monthly.iterrows():
        print(f"  {m:<6} {row.dlr_calc_mean:>10.1f} "
              f"{row.dlr_sensor_mean:>12.1f} "
              f"{row.ta_mean:>9.1f} "
              f"{int(row.heatwave_hrs):>8}")

    print("\n" + "=" * 55)
    print("  Validation complete.")
    print("=" * 55)

    return m1   # return overall metrics dict for use in other scripts


if __name__ == '__main__':
    run_validation('dlr_results_2021.csv')
