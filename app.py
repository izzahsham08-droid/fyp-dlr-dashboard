"""
app.py
======
Flask web server for the DLR Monitoring Dashboard.
Serves pre-processed results as JSON API endpoints.

Run:  python app.py
Then open:  http://127.0.0.1:5000
"""

from flask import Flask, jsonify, render_template, request
import pandas as pd
import numpy as np
import os

app = Flask(__name__)

# ─────────────────────────────────────────────
# LOAD DATA ONCE AT STARTUP
# ─────────────────────────────────────────────
DATA_PATH = 'dlr_results_2021.csv'
SLR       = 1434
HEATWAVE_THRESHOLD = 32.0

def load_data():
    if not os.path.exists(DATA_PATH):
        raise FileNotFoundError(
            f"{DATA_PATH} not found. "
            "Run  python dlr_model.py  first to generate it."
        )
    df = pd.read_csv(DATA_PATH, parse_dates=['datetime'])
    df = df.sort_values('datetime').reset_index(drop=True)
    return df

DF = load_data()


# ─────────────────────────────────────────────
# HELPER
# ─────────────────────────────────────────────
def safe_list(series):
    """Convert pandas Series to JSON-safe list (NaN → None)."""
    return [None if pd.isna(v) else round(float(v), 2) for v in series]

def filter_df(month=None, mode='all'):
    # Always restrict to 2021 only — dataset bleeds into 2022-01-01
    df = DF[DF['datetime'].dt.year == 2021].copy()
    if month and month != 0:
        df = df[df['datetime'].dt.month == month]
    if mode == 'heatwave':
        df = df[df['is_heatwave'] == 1]
    elif mode == 'normal':
        df = df[df['is_heatwave'] == 0]
    return df


# ─────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/summary')
def api_summary():
    """
    KPI cards for the DLR Monitoring tab.
    Supports three filter levels: year / month / specific date.
    Query params:
      month — 0 = full year, 1-12 = specific month (ignored when date is set)
      date  — 'YYYY-MM-DD' for daily view (overrides month)
      mode  — 'all' | 'normal' | 'heatwave'
    """
    month = request.args.get('month', 0, type=int)
    date  = request.args.get('date',  None)
    mode  = request.args.get('mode',  'all')

    # Base: always restrict to year 2021
    df = DF[DF['datetime'].dt.year == 2021].copy()

    # Period filter
    if date:
        df = df[df['datetime'].dt.strftime('%Y-%m-%d') == date]
    elif month and month != 0:
        df = df[df['datetime'].dt.month == month]

    # Condition filter
    if mode == 'heatwave':
        df = df[df['is_heatwave'] == 1]
    elif mode == 'normal':
        df = df[df['is_heatwave'] == 0]

    # Always split into hw/normal for card values regardless of mode
    # (so we can show both Mean DLR Normal and Mean DLR Heatwave)
    base_df = DF[DF['datetime'].dt.year == 2021].copy()
    if date:
        base_df = base_df[base_df['datetime'].dt.strftime('%Y-%m-%d') == date]
    elif month and month != 0:
        base_df = base_df[base_df['datetime'].dt.month == month]

    hw  = base_df[base_df['is_heatwave'] == 1]
    nrm = base_df[base_df['is_heatwave'] == 0]
    valid_dlr = df['dlr'].dropna()

    def safe_mean(s):
        return round(float(s.mean()), 1) if len(s) > 0 and not s.isna().all() else None
    def safe_pct(mask, total):
        return round(float(mask.mean() * 100), 1) if total > 0 else 0.0

    total  = len(df)
    hw_hrs = int(base_df['is_heatwave'].sum())

    # Period label for card sub-titles
    if date:
        period_label = date
    elif month == 0:
        period_label = 'Full Year 2021'
    else:
        period_label = pd.Timestamp(2021, month, 1).strftime('%B 2021')
    if mode == 'heatwave':
        period_label += ' · Heatwave only'
    elif mode == 'normal':
        period_label += ' · Normal only'

    return jsonify({
        'slr':                    SLR,
        'heatwave_threshold':     HEATWAVE_THRESHOLD,
        'period_label':           period_label,
        'total_hours':            total,
        'heatwave_hours':         hw_hrs,
        'heatwave_pct':           round(hw_hrs / total * 100, 1) if total else 0,
        'mean_dlr_calc_normal':   safe_mean(nrm['dlr_calculated']),
        'mean_dlr_calc_heatwave': safe_mean(hw['dlr_calculated']),
        'mean_dlr_sensor':        safe_mean(valid_dlr),
        'hours_above_slr':        int((df['dlr_calculated'] > SLR).sum()),
        'hours_below_slr':        int((df['dlr_calculated'] < SLR).sum()),
        'pct_above_slr':          safe_pct(df['dlr_calculated'] > SLR, total),
        'max_dlr_calc':           round(float(df['dlr_calculated'].max()), 1) if total else None,
        'min_dlr_calc':           round(float(df['dlr_calculated'].min()), 1) if total else None,
    })


@app.route('/api/timeseries')
def api_timeseries():
    """
    Time series data for the main chart.
    Query params:
      month  — 1–12, or 0/omitted for full year
      mode   — 'all' | 'heatwave' | 'normal'
      resample — 'H' (hourly) | 'D' (daily avg)
    """
    month    = request.args.get('month',    0,    type=int)
    mode     = request.args.get('mode',     'all')
    resample = request.args.get('resample', 'D')

    df = filter_df(month, mode)

    if resample == 'D':
        df = df.set_index('datetime').resample('D').mean(numeric_only=True).reset_index()

    return jsonify({
        'labels':          df['datetime'].dt.strftime('%Y-%m-%d').tolist(),
        'dlr_sensor':      safe_list(df['dlr']),
        'dlr_calculated':  safe_list(df['dlr_calculated']),
        'dlr_forecast':    safe_list(df['dlr_forecast']),
        'slr':             [SLR] * len(df),
        'ta':              safe_list(df['Ta']),
        'ts':              safe_list(df['Ts']),
        'wind_speed':      safe_list(df['Wind velocity']),
        'wind_dir':        safe_list(df['Wind direction']),
        'load':            safe_list(df['Load']),
        'is_heatwave':     [int(v) for v in df['is_heatwave'].fillna(0)],
    })


@app.route('/api/monthly')
def api_monthly():
    """Monthly averages for bar chart comparison."""
    months = ['Jan','Feb','Mar','Apr','May','Jun',
              'Jul','Aug','Sep','Oct','Nov','Dec']
    m = DF.groupby(DF['datetime'].dt.month).agg(
        dlr_calc   = ('dlr_calculated', 'mean'),
        dlr_sensor = ('dlr',            'mean'),
        dlr_fore   = ('dlr_forecast',   'mean'),
        ta         = ('Ta',             'mean'),
        hw_hours   = ('is_heatwave',    'sum'),
    ).round(1)

    return jsonify({
        'labels':      months,
        'dlr_calc':    safe_list(m['dlr_calc']),
        'dlr_sensor':  safe_list(m['dlr_sensor']),
        'dlr_forecast':safe_list(m['dlr_fore']),
        'slr':         [SLR] * 12,
        'ta':          safe_list(m['ta']),
        'hw_hours':    [int(v) for v in m['hw_hours']],
    })


@app.route('/api/heatwave_compare')
def api_heatwave_compare():
    """Normal vs heatwave DLR comparison data."""
    hw  = DF[DF['is_heatwave'] == 1]
    nrm = DF[DF['is_heatwave'] == 0]

    def safe_mean(s):
        v = s.dropna().mean()
        return round(float(v), 1) if not np.isnan(v) else None

    return jsonify({
        'categories': ['DLR Calculated', 'DLR Sensor', 'DLR Forecast', 'SLR'],
        'normal': [
            safe_mean(nrm['dlr_calculated']),
            safe_mean(nrm['dlr']),
            safe_mean(nrm['dlr_forecast']),
            SLR,
        ],
        'heatwave': [
            safe_mean(hw['dlr_calculated']),
            safe_mean(hw['dlr']),
            safe_mean(hw['dlr_forecast']),
            SLR,
        ],
    })


@app.route('/api/validation')
def api_validation():
    """Scatter data for calculated vs sensor validation plot."""
    valid = DF[['dlr', 'dlr_calculated', 'is_heatwave']].dropna()
    # Downsample for scatter (max 800 points for browser performance)
    if len(valid) > 800:
        valid = valid.sample(800, random_state=42).sort_index()

    return jsonify({
        'sensor':      safe_list(valid['dlr']),
        'calculated':  safe_list(valid['dlr_calculated']),
        'is_heatwave': valid['is_heatwave'].tolist(),
    })


@app.route('/api/validation_metrics')
def api_validation_metrics():
    """MAE, RMSE, MAPE, r for the validation panel."""
    valid = DF[['dlr', 'dlr_calculated', 'is_heatwave']].dropna()
    a, p  = valid['dlr'].values, valid['dlr_calculated'].values

    def calc(a, p):
        n    = int(len(a))
        mae  = float(np.mean(np.abs(a - p)))
        rmse = float(np.sqrt(np.mean((a - p)**2)))
        mape = float(np.mean(np.abs((a - p) / a)) * 100)
        r    = float(np.corrcoef(a, p)[0, 1])
        return dict(n=n, mae=round(mae,2), rmse=round(rmse,2),
                    mape=round(mape,2), r=round(r,4))

    hw_mask  = valid['is_heatwave'] == 1
    nrm_mask = valid['is_heatwave'] == 0

    return jsonify({
        'overall':  calc(a, p),
        'normal':   calc(valid.loc[nrm_mask,'dlr'].values,
                         valid.loc[nrm_mask,'dlr_calculated'].values),
        'heatwave': calc(valid.loc[hw_mask,'dlr'].values,
                         valid.loc[hw_mask,'dlr_calculated'].values)
                    if hw_mask.sum() > 0 else None,
    })


@app.route('/api/risk_monitor')
def api_risk_monitor():
    """Main DLR Operational Risk Monitor endpoint."""
    view  = request.args.get('view',  'yearly')
    month = request.args.get('month', 1, type=int)
    date  = request.args.get('date',  None)
    mode  = request.args.get('mode',  'all')   # all | normal | heatwave

    # Always restrict to 2021
    df = DF[DF['datetime'].dt.year == 2021].copy()

    if view == 'monthly':
        df = df[df['datetime'].dt.month == month]
    elif view == 'daily' and date:
        df = df[df['datetime'].dt.strftime('%Y-%m-%d') == date]

    # Apply condition filter AFTER date filter
    if mode == 'heatwave':
        df = df[df['is_heatwave'] == 1]
    elif mode == 'normal':
        df = df[df['is_heatwave'] == 0]

    df = df.copy()
    df['margin_dlr_pct']  = ((df['dlr_calculated'] - df['Load']) / df['dlr_calculated'] * 100).round(2)
    conds   = [(df['Load'] > df['dlr_calculated']) | (df['Load'] > SLR),
               df['margin_dlr_pct'] < 5, df['margin_dlr_pct'] < 10]
    choices = ['Very Risky', 'Risky', 'Caution']
    df['risk'] = np.select(conds, choices, default='Safe')

    df['load_slr_pct']    = (df['Load'] / SLR * 100).round(2)
    df['load_dlrc_pct']   = (df['Load'] / df['dlr_calculated'] * 100).round(2)
    df['load_dlrs_pct']   = (df['Load'] / df['dlr'] * 100).round(2)
    df['load_dlrf_pct']   = (df['Load'] / df['dlr_forecast'] * 100).round(2)
    df['margin_slr_pct']  = ((SLR - df['Load']) / SLR * 100).round(2)
    df['dlrc_vs_slr_pct'] = ((df['dlr_calculated'] - SLR) / SLR * 100).round(2)
    df['dlrs_vs_slr_pct'] = ((df['dlr'] - SLR) / SLR * 100).round(2)
    df['dlrf_vs_slr_pct'] = ((df['dlr_forecast'] - SLR) / SLR * 100).round(2)
    df['dlrc_vs_slr_a']   = (df['dlr_calculated'] - SLR).round(1)
    df['dlrs_vs_slr_a']   = (df['dlr'] - SLR).round(1)
    df['dlrf_vs_slr_a']   = (df['dlr_forecast'] - SLR).round(1)

    total     = len(df)
    risky_hrs = int(df['risk'].isin(['Risky','Very Risky']).sum())
    above80   = int((df['Load'] > SLR * 0.80).sum())
    above90   = int((df['Load'] > SLR * 0.90).sum())
    vl = df['Load'].dropna(); vd = df['dlr_calculated'].dropna(); vm = df['margin_dlr_pct'].dropna()

    summary = {
        'max_load':        round(float(vl.max()), 1),
        'mean_load':       round(float(vl.mean()), 1),
        'max_dlr_calc':    round(float(vd.max()), 1),
        'mean_dlr_calc':   round(float(vd.mean()), 1),
        'min_margin_dlrc': round(float(vm.min()), 2),
        'risky_pct':       round(risky_hrs / total * 100, 2) if total else 0,
        'above80_pct':     round(above80 / total * 100, 2)  if total else 0,
        'above90_pct':     round(above90 / total * 100, 2)  if total else 0,
        'risk_counts': {
            'Safe':       int((df['risk'] == 'Safe').sum()),
            'Caution':    int((df['risk'] == 'Caution').sum()),
            'Risky':      int((df['risk'] == 'Risky').sum()),
            'Very Risky': int((df['risk'] == 'Very Risky').sum()),
        },
    }

    def sl(s):
        return [None if pd.isna(v) else (round(float(v), 2) if isinstance(v, (float, np.floating)) else v)
                for v in s]

    rows = df[['datetime','Load','dlr_calculated','dlr','dlr_forecast',
               'Ta','Wind velocity','Wind direction',
               'load_slr_pct','load_dlrc_pct','load_dlrs_pct','load_dlrf_pct',
               'margin_slr_pct','margin_dlr_pct',
               'dlrc_vs_slr_a','dlrc_vs_slr_pct','dlrs_vs_slr_a','dlrs_vs_slr_pct',
               'dlrf_vs_slr_a','dlrf_vs_slr_pct','risk']].copy()

    return jsonify({
        'summary':         summary,
        'labels':          rows['datetime'].dt.strftime('%Y-%m-%d %H:%M').tolist(),
        'load':            sl(rows['Load']),
        'dlr_calc':        sl(rows['dlr_calculated']),
        'dlr_sensor':      sl(rows['dlr']),
        'dlr_forecast':    sl(rows['dlr_forecast']),
        'ta':              sl(rows['Ta']),
        'wind_speed':      sl(rows['Wind velocity']),
        'wind_dir':        sl(rows['Wind direction']),
        'load_slr_pct':    sl(rows['load_slr_pct']),
        'load_dlrc_pct':   sl(rows['load_dlrc_pct']),
        'load_dlrs_pct':   sl(rows['load_dlrs_pct']),
        'load_dlrf_pct':   sl(rows['load_dlrf_pct']),
        'margin_slr_pct':  sl(rows['margin_slr_pct']),
        'margin_dlr_pct':  sl(rows['margin_dlr_pct']),
        'dlrc_vs_slr_a':   sl(rows['dlrc_vs_slr_a']),
        'dlrc_vs_slr_pct': sl(rows['dlrc_vs_slr_pct']),
        'dlrs_vs_slr_a':   sl(rows['dlrs_vs_slr_a']),
        'dlrs_vs_slr_pct': sl(rows['dlrs_vs_slr_pct']),
        'dlrf_vs_slr_a':   sl(rows['dlrf_vs_slr_a']),
        'dlrf_vs_slr_pct': sl(rows['dlrf_vs_slr_pct']),
        'risk':            rows['risk'].tolist(),
    })



@app.route('/api/wind_analysis')
def api_wind_analysis():
    """
    Wind velocity and direction data for polar scatter chart.
    Query params:
      month — 0 = full year 2021, 1-12 = specific month
      mode  — all | normal | heatwave
    Returns downsampled points suitable for a polar scatter plot.
    """
    month = request.args.get('month', 0, type=int)
    mode  = request.args.get('mode',  'all')

    df = filter_df(month, mode).copy()

    # Add risk level
    df['margin_pct'] = ((df['dlr_calculated'] - df['Load']) / df['dlr_calculated'] * 100)
    conds   = [(df['Load'] > df['dlr_calculated']) | (df['Load'] > SLR),
               df['margin_pct'] < 5,
               df['margin_pct'] < 10]
    choices = ['Very Risky', 'Risky', 'Caution']
    df['risk'] = np.select(conds, choices, default='Safe')

    # Downsample for browser performance — max 500 points for yearly, all for monthly/daily
    if month == 0 and len(df) > 500:
        df = df.sample(500, random_state=42).sort_values('datetime')

    def sl(s):
        return [None if pd.isna(v) else round(float(v), 2) for v in s]

    return jsonify({
        'datetime':   df['datetime'].dt.strftime('%Y-%m-%d %H:%M').tolist(),
        'wind_speed': sl(df['Wind velocity']),
        'wind_dir':   sl(df['Wind direction']),
        'ta':         sl(df['Ta']),
        'ts':         sl(df['Ts']),
        'load':       sl(df['Load']),
        'dlr_calc':   sl(df['dlr_calculated']),
        'dlr_sensor': sl(df['dlr']),
        'dlr_fore':   sl(df['dlr_forecast']),
        'risk':       df['risk'].tolist(),
        'month':      int(month),
        'total_pts':  int(len(df)),
    })

@app.route('/api/risk_dates')
def api_risk_dates():
    """Return available months and dates for the controls."""
    months = [{'value': int(m), 'label': pd.Timestamp(2021, int(m), 1).strftime('%B')}
              for m in sorted(DF['datetime'].dt.month.unique())]
    dates  = sorted(DF['datetime'].dt.strftime('%Y-%m-%d').unique().tolist())
    return jsonify({'months': months, 'dates': dates})


if __name__ == '__main__':
    import os
    # debug=True for local development only
    # On cloud platforms (Render, Railway, PythonAnywhere),
    # gunicorn is used instead and this block is not executed.
    is_local = os.environ.get('FLASK_ENV') != 'production'
    print("\n DLR Monitoring Dashboard")
    print(" Open http://127.0.0.1:5000 in your browser\n")
    app.run(debug=is_local, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
