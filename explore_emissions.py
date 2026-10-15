"""
explore_emissions.py

Exploratory static figures for the Emissions Explorer dataset (IMF quarterly
greenhouse gas air emissions accounts). Writes PNGs to images/.

The source CSV has overlapping rows, so each figure selects one consistent
slice rather than summing everything:
  - every series appears both seasonally adjusted and not (we use seasonally adjusted)
  - "Greenhouse gas" is the total of the individual gases
  - "Total Industry and Households" is the total of the individual sectors
  - regions overlap (World, G20, continents, sub-regions), so cross-region
    comparisons use the five non-overlapping continents

Requirements: pandas, matplotlib
Run:          python explore_emissions.py
"""

import re
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

CSV_PATH = Path("emissions.csv")
OUT_DIR = Path("images")
OUT_DIR.mkdir(parents=True, exist_ok=True)

SEASONAL = "Seasonally Adjusted"
TOTAL_GAS = "Greenhouse gas"
TOTAL_INDUSTRY = "Total Industry and Households"
CONTINENTS = ["Africa", "Americas", "Asia", "Europe", "Oceania"]
BASE_YEAR, COMPARE_YEAR = 2010, 2024

# ---------- Load and reshape to long format ----------
df = pd.read_csv(CSV_PATH)
quarter_cols = [c for c in df.columns if re.fullmatch(r"\d{4}Q[1-4]", c)]
id_cols = ["Country", "Industry", "Gas Type", "Seasonal Adjustment", "Unit"]

long = (
    df[id_cols + quarter_cols]
    .melt(id_vars=id_cols, value_vars=quarter_cols, var_name="Period", value_name="Emissions")
    .dropna(subset=["Emissions"])
)
long = long[long["Seasonal Adjustment"] == SEASONAL].copy()
long["Year"] = long["Period"].str[:4].astype(int)
long["Date"] = pd.PeriodIndex(long["Period"], freq="Q").to_timestamp()
long["Industry"] = long["Industry"].replace({"Total Households": "Households"})
UNIT = long["Unit"].iloc[0]

totals = long[(long["Gas Type"] == TOTAL_GAS) & (long["Industry"] == TOTAL_INDUSTRY)]
by_sector = long[(long["Gas Type"] == TOTAL_GAS) & (long["Industry"] != TOTAL_INDUSTRY)]
by_gas = long[(long["Industry"] == TOTAL_INDUSTRY) & (long["Gas Type"] != TOTAL_GAS)]
continents = totals[totals["Country"].isin(CONTINENTS)]


def save(name: str) -> None:
    plt.tight_layout()
    plt.savefig(OUT_DIR / name, dpi=150)
    plt.close()


# ---------- 1) World emissions over time ----------
world = totals[totals["Country"] == "World"].sort_values("Date")
plt.figure(figsize=(12, 5))
plt.plot(world["Date"], world["Emissions"])
plt.title("World Greenhouse Gas Emissions (seasonally adjusted)")
plt.xlabel("Quarter")
plt.ylabel(f"Emissions ({UNIT})")
save("fig1_global_emissions_over_time.png")

# ---------- 2) Continents, latest quarter ----------
latest = continents["Period"].max()
latest_vals = (continents[continents["Period"] == latest]
               .set_index("Country")["Emissions"].sort_values(ascending=False))
plt.figure(figsize=(10, 5))
latest_vals.plot(kind="bar")
plt.title(f"Greenhouse Gas Emissions by Continent, {latest}")
plt.xlabel("")
plt.ylabel(f"Emissions ({UNIT})")
plt.xticks(rotation=0)
save("fig2_top10_regions_latest_period.png")

# ---------- 3) World emissions by sector (top 4) ----------
world_sector = by_sector[by_sector["Country"] == "World"]
top_sectors = world_sector.groupby("Industry")["Emissions"].sum().nlargest(4).index
plt.figure(figsize=(12, 6))
for sector in top_sectors:
    sub = world_sector[world_sector["Industry"] == sector].sort_values("Date")
    plt.plot(sub["Date"], sub["Emissions"], label=sector)
plt.legend()
plt.title("World Emissions by Sector (top 4)")
plt.xlabel("Quarter")
plt.ylabel(f"Emissions ({UNIT})")
save("fig3_industry_trends_excl_total.png")

# ---------- 4) World emissions by gas (stacked) ----------
world_gas = (by_gas[by_gas["Country"] == "World"]
             .pivot_table(index="Date", columns="Gas Type", values="Emissions", aggfunc="sum")
             .fillna(0).sort_index())
world_gas = world_gas[world_gas.sum().sort_values(ascending=False).index]
plt.figure(figsize=(12, 6))
plt.stackplot(world_gas.index, world_gas.values.T, labels=world_gas.columns)
plt.legend(loc="upper left")
plt.title("World Emissions by Gas")
plt.xlabel("Quarter")
plt.ylabel(f"Emissions ({UNIT})")
save("fig4_gas_type_stacked_area.png")

# ---------- 5) Percent change by continent ----------
yearly = continents.groupby(["Country", "Year"])["Emissions"].sum().unstack()
change = ((yearly[COMPARE_YEAR] - yearly[BASE_YEAR]) / yearly[BASE_YEAR] * 100).sort_values()
plt.figure(figsize=(10, 5))
plt.barh(change.index, change.values)
plt.axvline(0, linestyle="--", color="gray")
plt.title(f"Change in Annual Emissions by Continent, {BASE_YEAR} to {COMPARE_YEAR}")
plt.xlabel("Percent change (%)")
save("fig5_region_percent_change_countries_only.png")

# ---------- 6) Continent trends ----------
plt.figure(figsize=(12, 6))
for name in CONTINENTS:
    sub = continents[continents["Country"] == name].sort_values("Date")
    plt.plot(sub["Date"], sub["Emissions"], label=name)
plt.legend()
plt.title("Greenhouse Gas Emissions by Continent")
plt.xlabel("Quarter")
plt.ylabel(f"Emissions ({UNIT})")
save("fig6_top5_region_trends.png")

print(f"Saved figures to {OUT_DIR.resolve()}")
print(change.round(1).to_string())
