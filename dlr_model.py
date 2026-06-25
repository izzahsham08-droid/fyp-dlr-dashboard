"""
dlr_model.py
============
IEEE Std 738-2012 Dynamic Line Rating (DLR) model.
Calculates steady-state ampacity (thermal rating) for a bare overhead
conductor given real-time weather conditions.

Conductor assumed: Drake ACSR 795 kcmil 26/7
Location:         Peninsular Malaysia (approx. lat 3.1°N)
Reference:        IEEE Std 738-2012, Section 4.4
"""

import numpy as np
import pandas as pd

# ─────────────────────────────────────────────
# CONDUCTOR & LINE PARAMETERS  (Drake ACSR)
# ─────────────────────────────────────────────
D0      = 0.02814   # m  — outer conductor diameter
EPSILON = 0.8       # —   emissivity
ALPHA   = 0.8       # —   solar absorptivity
R_LOW   = 2.030e-5  # Ω/m at T_LOW  (calibrated to dataset)
R_HIGH  = 2.420e-5  # Ω/m at T_HIGH (calibrated to dataset)
T_LOW   = 25.0      # °C
T_HIGH  = 75.0      # °C
T_MAX   = 90.0      # °C  maximum allowable conductor surface temperature

# ─────────────────────────────────────────────
# SITE PARAMETERS
# ─────────────────────────────────────────────
HE      = 0.0       # m   — elevation above sea level
LAT     = 3.1       # °   — latitude (Peninsular Malaysia)
ZL      = 90.0      # °   — line azimuth (east–west orientation assumed)

# ─────────────────────────────────────────────
# PROJECT CONSTANTS
# ─────────────────────────────────────────────
SLR               = 1434   # A  — Static Line Rating (fixed conservative rating)
HEATWAVE_THRESHOLD = 32.0  # °C — Ta >= this → heatwave condition


# ══════════════════════════════════════════════════════════════
# SECTION 4.5  — Air property equations (SI units)
# ══════════════════════════════════════════════════════════════

def air_properties(Ts, Ta):
    """
    Returns (mu_f, rho_f, kf) at the boundary-layer film temperature.

    mu_f  — dynamic viscosity  [kg/m·s]   Eq. 13a
    rho_f — air density        [kg/m³]    Eq. 14a
    kf    — thermal conductivity [W/m·°C] Eq. 15a
    """
    Tfilm = (Ts + Ta) / 2.0                                     # Eq. 6
    mu_f  = 1.458e-6 * (Tfilm + 273)**1.5 / (Tfilm + 383.4)    # Eq. 13a
    rho_f = 1.293 / (1.0 + 0.00367 * Tfilm)                     # Eq. 14a (sea level)
    kf    = 2.424e-2 + 7.477e-5 * Tfilm - 4.407e-9 * Tfilm**2  # Eq. 15a
    return mu_f, rho_f, kf


# ══════════════════════════════════════════════════════════════
# SECTION 4.4.3 — Convection heat loss
# ══════════════════════════════════════════════════════════════

def convection_loss(Ts, Ta, Vw, wind_dir_compass):
    """
    Returns qc [W/m] — the larger of forced and natural convection.

    wind_dir_compass : compass bearing of wind (0–360°).
    Converted to angle from conductor axis using line azimuth ZL.
    IEEE 738 Eq. 3a, 3b (forced), Eq. 5a (natural), Eq. 4b (Kangle).
    """
    mu_f, rho_f, kf = air_properties(Ts, Ta)

    # ── Wind direction factor Kangle (Eq. 4b) ──────────────────
    # phi = angle between wind direction and conductor axis
    phi   = abs(wind_dir_compass - ZL) % 180   # 0–180°
    phi   = min(phi, 180 - phi)                 # 0–90°
    beta  = np.radians(90.0 - phi)              # complement → angle from perpendicular
    Kangle = (1.194 - np.sin(beta)
              - 0.194 * np.cos(2 * beta)
              + 0.368 * np.sin(2 * beta))
    Kangle = max(Kangle, 0.0)

    # ── Natural convection Eq. 5a ───────────────────────────────
    dT  = max(Ts - Ta, 0.01)
    qcn = 3.645 * rho_f**0.5 * D0**0.75 * dT**1.25

    if Vw <= 0:
        return qcn

    # ── Reynolds number Eq. 2c ──────────────────────────────────
    NRe = D0 * rho_f * Vw / mu_f

    # ── Forced convection Eq. 3a and 3b ────────────────────────
    qc1 = Kangle * (1.01 + 1.35 * NRe**0.52) * kf * dT   # Eq. 3a
    qc2 = Kangle * 0.754 * NRe**0.6  * kf * dT            # Eq. 3b
    qcf = max(qc1, qc2)                                    # take larger (Sect 4.4.3.1)

    return max(qcf, qcn)                                   # take larger of forced/natural


# ══════════════════════════════════════════════════════════════
# SECTION 4.4.4 — Radiated heat loss
# ══════════════════════════════════════════════════════════════

def radiation_loss(Ts, Ta):
    """
    Returns qr [W/m] — Stefan-Boltzmann radiation.  Eq. 7a
    """
    return (0.0178 * EPSILON * D0
            * (((Ts + 273) / 100)**4 - ((Ta + 273) / 100)**4))


# ══════════════════════════════════════════════════════════════
# SECTION 4.5.4–4.5.7 — Solar heat gain
# ══════════════════════════════════════════════════════════════

def solar_gain(hour, day_of_year):
    """
    Returns qs [W/m] — direct solar heat input to conductor.
    Eqs. 8, 9, 16a, 16b, 17a, 17b, 18, 19, 20.
    Returns 0 at night (Hc ≤ 0).
    """
    DEG = np.pi / 180.0

    # Solar declination Eq. 16b
    delta = 23.46 * np.sin((284 + day_of_year) / 365.0 * 2 * np.pi)

    # Hour angle: 15° per hour from solar noon  Eq. 16a comment
    omega = (hour - 12) * 15.0

    # Solar altitude Hc  Eq. 16a
    H3arg = (np.cos(LAT * DEG) * np.cos(delta * DEG) * np.cos(omega * DEG)
             + np.sin(LAT * DEG) * np.sin(delta * DEG))
    H3arg = np.clip(H3arg, -1.0, 1.0)
    Hc    = np.degrees(np.arcsin(H3arg))

    if Hc <= 0:
        return 0.0

    # Solar heat flux at sea level, clear atmosphere  Eq. 18 / Table 3
    H  = Hc
    Qs = (-42.2391 + 63.8044*H - 1.922*H**2 + 3.46921e-2*H**3
          - 3.61118e-4*H**4 + 1.94318e-6*H**5 - 4.07608e-9*H**6)
    Qs = max(Qs, 0.0)

    # Elevation correction  Eq. 19–20
    Ksolar = 1.0 + 1.148e-4 * HE - 1.108e-8 * HE**2
    Qse    = Ksolar * Qs

    # Solar azimuth  Eq. 17a, 17b
    chi_denom = (np.sin(LAT * DEG) * np.cos(omega * DEG)
                 - np.cos(LAT * DEG) * np.tan(delta * DEG))
    chi = np.sin(omega * DEG) / chi_denom if abs(chi_denom) > 1e-9 else 0.0

    if omega < 0 and chi >= 0:
        C = 0.0
    elif omega >= 0 and chi < 0:
        C = 360.0
    else:
        C = 180.0
    Zc = C + np.degrees(np.arctan(chi))

    # Effective angle of incidence  Eq. 9
    cos_theta = np.cos(Hc * DEG) * np.cos((Zc - ZL) * DEG)
    cos_theta = np.clip(cos_theta, -1.0, 1.0)
    theta = np.arccos(cos_theta)

    qs = ALPHA * Qse * np.sin(theta) * D0
    return max(qs, 0.0)


# ══════════════════════════════════════════════════════════════
# SECTION 4.4.6 — Conductor AC resistance
# ══════════════════════════════════════════════════════════════

def conductor_resistance(Tavg):
    """
    Returns R(Tavg) [Ω/m] by linear interpolation.  Eq. 10
    """
    return R_LOW + (R_HIGH - R_LOW) * (Tavg - T_LOW) / (T_HIGH - T_LOW)


# ══════════════════════════════════════════════════════════════
# SECTION 4.1.1 — Steady-state thermal rating (ampacity)
# ══════════════════════════════════════════════════════════════

def calculate_dlr(Ta, Vw, wind_dir, hour, day_of_year, Ts_limit=None):
    """
    Returns steady-state ampacity I [A] from heat balance Eq. 1b:

        I = sqrt( (qc + qr - qs) / R(Ts) )

    Parameters
    ----------
    Ta          : float — ambient temperature [°C]
    Vw          : float — wind speed [m/s]
    wind_dir    : float — wind compass bearing [°, 0–360]
    hour        : int   — hour of day (0–23, local solar time)
    day_of_year : int   — day of year (1–365)
    Ts_limit    : float — max conductor surface temp [°C]; defaults to T_MAX

    Returns
    -------
    float — ampacity in Amperes (0 if heat balance cannot be satisfied)
    """
    if Ts_limit is None:
        Ts_limit = T_MAX

    # Guard: if ambient already exceeds limit, rating is zero
    if Ta >= Ts_limit:
        return 0.0

    Vw = max(Vw, 0.01)   # avoid division by zero in Reynolds number

    qc = convection_loss(Ts_limit, Ta, Vw, wind_dir)
    qr = radiation_loss(Ts_limit, Ta)
    qs = solar_gain(hour, day_of_year)
    R  = conductor_resistance(Ts_limit)

    net = qc + qr - qs
    if net <= 0:
        return 0.0

    return float(np.sqrt(net / R))


# ══════════════════════════════════════════════════════════════
# BATCH PROCESSING — apply model to the full dataset
# ══════════════════════════════════════════════════════════════

def process_dataset(input_path_dlr, input_path_forecast, output_path):
    """
    Loads raw data, applies IEEE 738 model to every row,
    merges with forecast data, and saves the enriched CSV.

    Returns the processed DataFrame.
    """
    print("Loading DLR sensor data...")
    df = pd.read_excel(input_path_dlr)
    df['datetime'] = pd.to_datetime(df['Time'])
    df = df.sort_values('datetime').reset_index(drop=True)

    # ── Fill small gaps by linear interpolation (max 2 consecutive hours) ──
    df.set_index('datetime', inplace=True)
    numeric_cols = ['Ta', 'Ts', 'Wind velocity', 'Wind direction', 'Load', 'dlr']
    df[numeric_cols] = df[numeric_cols].interpolate(
        method='time', limit=2, limit_direction='both'
    )
    df.reset_index(inplace=True)

    # ── Derived time fields ─────────────────────────────────────
    df['hour']        = df['datetime'].dt.hour
    df['day_of_year'] = df['datetime'].dt.day_of_year
    df['month']       = df['datetime'].dt.month
    df['date_str']    = df['datetime'].dt.strftime('%Y-%m-%d %H:%M')

    # ── IEEE 738 model ──────────────────────────────────────────
    print("Calculating DLR using IEEE 738 model...")
    df['dlr_calculated'] = df.apply(
        lambda r: calculate_dlr(
            r['Ta'],
            r['Wind velocity'],
            r['Wind direction'],
            r['hour'],
            r['day_of_year']
        ), axis=1
    ).round(1)

    # ── Heatwave flag ───────────────────────────────────────────
    df['is_heatwave'] = (df['Ta'] >= HEATWAVE_THRESHOLD).astype(int)

    # ── SLR column ──────────────────────────────────────────────
    df['slr'] = SLR

    # ── Load DLR forecast data ──────────────────────────────────
    print("Merging DLR forecast data...")
    dlrf = pd.read_excel(input_path_forecast)
    dlrf['datetime'] = pd.to_datetime(dlrf['date'])
    dlrf = dlrf.rename(columns={'dlrf_24hr': 'dlr_forecast'})[['datetime', 'dlr_forecast']]

    df = df.merge(dlrf, on='datetime', how='left')

    # ── Capacity gain vs SLR ────────────────────────────────────
    df['dlr_vs_slr'] = (df['dlr_calculated'] - SLR).round(1)

    # ── Save ────────────────────────────────────────────────────
    df.to_csv(output_path, index=False)
    print(f"Saved {len(df)} rows → {output_path}")

    # ── Quick summary ───────────────────────────────────────────
    hw  = df[df['is_heatwave'] == 1]
    nrm = df[df['is_heatwave'] == 0]
    print("\n── Summary ──────────────────────────────────")
    print(f"  Total hours           : {len(df)}")
    print(f"  Heatwave hours (≥32°C): {len(hw)}  ({100*len(hw)/len(df):.1f}%)")
    print(f"  Normal hours          : {len(nrm)}")
    print(f"  Mean DLR calc (normal)   : {nrm['dlr_calculated'].mean():.1f} A")
    print(f"  Mean DLR calc (heatwave) : {hw['dlr_calculated'].mean():.1f} A")
    print(f"  Mean DLR sensor          : {df['dlr'].mean():.1f} A")
    print(f"  SLR (fixed)              : {SLR} A")
    print(f"  Hours DLR calc > SLR     : {(df['dlr_calculated'] > SLR).sum()}  ({100*(df['dlr_calculated'] > SLR).mean():.1f}%)")
    print(f"  Hours DLR calc < SLR     : {(df['dlr_calculated'] < SLR).sum()}  ({100*(df['dlr_calculated'] < SLR).mean():.1f}%)")

    return df


if __name__ == '__main__':
    process_dataset(
        input_path_dlr      = 'dlr_data_2021.xlsx',
        input_path_forecast = 'dlrf_24hr_2021_hourly.xlsx',
        output_path         = 'dlr_results_2021.csv'
    )
