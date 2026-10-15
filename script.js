// script.js — Emissions Explorer (final consolidated build)
(function() {
  // ===== Utilities =====
  function byId(id) { return d3.select("#" + id); }
  let container = byId("viz");
  if (container.empty()) {
    container = d3.select("body").append("div").attr("id", "viz").style("margin", "1rem");
  }

  function getWidth() {
    const wrap = document.querySelector(".wrap");
    const w = wrap ? wrap.clientWidth : container.node().clientWidth || window.innerWidth;
    return Math.min(1100, Math.max(640, w || 800));
  }

  // Stable color mapping per (groupBy::key)
  const colorCache = new Map();
  // Distinct colors that read well on the dark background. Assigned in the
  // order keys are first seen for each grouping, so a sector keeps its color
  // when you switch regions.
  const PALETTE = ["#5b8ff9", "#f6bd16", "#5ad8a6", "#e8684a", "#9270ca",
                   "#6dc8ec", "#ff9d4d", "#ff99c3", "#a3b1bf", "#269a99"];
  const OTHER_COLOR = "#4a5163";
  const colorIndex = new Map();
  function colorFor(groupBy, key){
    if (key === "Other") return OTHER_COLOR;
    const K = (groupBy||"") + "::" + (key||"");
    if (colorCache.has(K)) return colorCache.get(K);
    const n = colorIndex.get(groupBy) || 0;
    colorIndex.set(groupBy, n + 1);
    const c = PALETTE[n % PALETTE.length];
    colorCache.set(K, c);
    return c;
  }

  const CFG = {
    topN: 6,
    margin: {top: 20, right: 18, bottom: 32, left: 72},
    marginOverview: {top: 4, right: 18, bottom: 24, left: 72},
    height: 420,
    heightOverview: 90,
    MAX_PCT: 300
  };

  const W = getWidth();
  const svg = container.append("svg")
    .attr("width", W)
    .attr("height", CFG.height + CFG.heightOverview + CFG.margin.top + CFG.margin.bottom + 56);

  const gMain = svg.append("g").attr("transform", `translate(${CFG.margin.left},${CFG.margin.top})`);
  const gOverview = svg.append("g").attr("transform", `translate(${CFG.marginOverview.left},${CFG.margin.top + CFG.height + 34})`);

  const innerW = W - CFG.margin.left - CFG.margin.right;
  const innerWOverview = W - CFG.marginOverview.left - CFG.marginOverview.right;
  const innerH = CFG.height - CFG.margin.top + 6;
  const innerHOverview = CFG.heightOverview - CFG.marginOverview.top - CFG.marginOverview.bottom;

  const x = d3.scaleUtc().range([0, innerW]);
  const xOverview = d3.scaleUtc().range([0, innerWOverview]);
  const y = d3.scaleLinear().range([innerH, 0]);
  const yOverview = d3.scaleLinear().range([innerHOverview, 0]);

  const area = d3.area()
      .defined(d => Number.isFinite(d[0]) && Number.isFinite(d[1]))
      .x(d => x(d.data.quarter))
      .y0(d => y(d[0]))
      .y1(d => y(d[1]));

  const areaOverview = d3.area()
      .defined(d => Number.isFinite(d[0]) && Number.isFinite(d[1]))
      .x(d => xOverview(d.data.quarter))
      .y0(d => yOverview(d[0]))
      .y1(d => yOverview(d[1]));

  const xAxisG = gMain.append("g").attr("transform", `translate(0,${innerH})`);
  const yAxisG = gMain.append("g");

  const clipId = "clipMain";
  svg.append("clipPath").attr("id", clipId)
     .append("rect").attr("x", 0).attr("y", 0)
     .attr("width", innerW).attr("height", innerH);

  const gSeries = gMain.append("g").attr("clip-path", `url(#${clipId})`);

  const tooltip = d3.select("#tooltip").empty()
    ? d3.select("body").append("div").attr("id","tooltip") : d3.select("#tooltip");

  function parseQuarter(q) {
    const m = /^([0-9]{4})Q([1-4])$/.exec(q);
    if (!m) return null;
    const year = +m[1], qIdx = +m[2]-1, month = qIdx*3;
    return new Date(Date.UTC(year, month, 1));
  }
  function pct(a,b){ return (b===0||b==null)? null : (a-b)/b; }

  const regionSelect = d3.select("#regionSelect");
  const groupBySelect = d3.select("#groupBySelect");
  const metricSelect = d3.select("#metricSelect");

  d3.csv("./emissions.csv").then(raw => {
    if (!raw || !raw.length) throw new Error("No rows in emissions.csv");

    const cols = raw.columns || Object.keys(raw[0]);
    const quarterCols = cols.filter(c => /^\d{4}Q[1-4]$/.test(c)).sort();

    // Robust region column detection
    const regionCandidates = ["Country","Region","Region Name","Area","Location"];
    let REGION_COL = regionCandidates.find(c => cols.includes(c)) || null;
    if (!REGION_COL) throw new Error("Missing region/country column");

    const HAVE_INDUSTRY = cols.includes("Industry");
    const HAVE_GAS = cols.includes("Gas Type");

    // Populate region select if present
    const regions = Array.from(new Set(raw.map(r => ((r[REGION_COL]||"")+"").trim())))
      .sort((a,b) => (a==="World"? -1 : b==="World"? 1 : d3.ascending(a,b)));
    if (!regionSelect.empty()) {
      regionSelect.selectAll("option").data(regions, d=>d).join("option")
        .attr("value", d => d).text(d => d);
      regionSelect.property("value", regions.indexOf("World")>=0 ? "World" : regions[0]);
    }

    // Normalize groupBy value to dataset columns
    function normalizedGroupBy(){
      const v = (groupBySelect.empty() ? "Industry" : groupBySelect.property("value")) || "Industry";
      const s = String(v).toLowerCase();
      if (s.includes("gas")) return HAVE_GAS ? "Gas Type" : (HAVE_INDUSTRY ? "Industry" : null);
      if (s.includes("industry")) return HAVE_INDUSTRY ? "Industry" : (HAVE_GAS ? "Gas Type" : null);
      return HAVE_INDUSTRY ? "Industry" : (HAVE_GAS ? "Gas Type" : null);
    }

    // The source file has overlapping rows: every series appears both
    // seasonally adjusted and not, every industry has a "Greenhouse gas" total
    // alongside the individual gases, and every gas has a "Total Industry and
    // Households" row alongside the sectors. Summing everything would count the
    // same emissions several times over, so each view picks one consistent slice:
    //   by industry -> total GHG for each sector (no all-sector total)
    //   by gas      -> all sectors combined for each gas (no all-gas total)
    const TOTAL_GAS = "Greenhouse gas";
    const TOTAL_INDUSTRY = "Total Industry and Households";
    function displayIndustry(name){ return name === "Total Households" ? "Households" : name; }
    function inView(d, groupBy){
      if (groupBy === "Industry") return d.gas === TOTAL_GAS && d.industry !== TOTAL_INDUSTRY;
      return d.industry === TOTAL_INDUSTRY && d.gas !== TOTAL_GAS;
    }

    // Long format
    const long = [];
    for (const row of raw) {
      const region = ((row[REGION_COL]||"")+"").trim();
      if (!region) continue;
      for (const q of quarterCols) {
        const v = +row[q];
        if (!Number.isFinite(v)) continue;
        const dt = parseQuarter(q);
        if (!dt) continue;
        long.push({
          region,
          industry: displayIndustry(((row["Industry"]||"")+"").trim()) || null,
          gas: ((row["Gas Type"]||"")+"").trim() || null,
          sa: ((row["Seasonal Adjustment"]||"")+"").trim(),
          quarter: dt,
          value: v
        });
      }
    }

    const brush = d3.brushX()
      .extent([[0,0], [innerWOverview, innerHOverview]])
      .on("brush end", brushed);

    const gBrush = gOverview.append("g").attr("class","brush");

    function firstNonZero(arr){
      for (let i=0;i<arr.length;i++){
        if (arr[i] && Number.isFinite(arr[i].value) && Math.abs(arr[i].value) > 0) return +arr[i].value;
      }
      return 1;
    }

    function update() {
      const selRegion = regionSelect.empty() ? "" : (regionSelect.property("value") || "");
      const regionNorm = selRegion.trim().toLowerCase();
      const groupBy = normalizedGroupBy();
      const metric = (metricSelect.empty() ? "absolute" : metricSelect.property("value")) || "absolute";

      if (!groupBy) return clearViz("No valid grouping available in this dataset.");

      const saSelect = d3.select("#saSelect");
      const saWanted = saSelect.empty() ? "Seasonally Adjusted" : saSelect.property("value");
      const data = long.filter(d =>
        d.region.trim().toLowerCase() === regionNorm && d.sa === saWanted && inView(d, groupBy));
      
      if (!data.length) {
        // Auto-fallback to first region that has data
        const byRegion = d3.rollup(long, v => v.length, d => d.region);
        const firstWithData = Array.from(byRegion.keys()).find(r => (byRegion.get(r) > 0));
        if (firstWithData) {
          if (!regionSelect.empty()) regionSelect.property("value", firstWithData);
          // Recompute with fallback region
          const regionAlt = firstWithData.trim().toLowerCase();
          const dataAlt = long.filter(d => d.region.trim().toLowerCase() === regionAlt);
          if (dataAlt.length) {
            // Replace local bindings and continue
            return (function() {
              const tmp = dataAlt; // new data scope
              // re-run grouping/stacking with dataAlt by calling a local helper
              // We'll set a flag and let update re-run after setting the select value.
              update();
              return;
            })();
          }
        }
        return clearViz("No data for this selection.");
      }

      const keyAccessor = (d) => (groupBy === "Industry" ? d.industry : d.gas);

      const groupedRaw = d3.rollup(
        data,
        v => d3.sum(v, d => d.value),
        d => keyAccessor(d),
        d => +d.quarter
      );

      function buildSeries(){
        const out = [];
        groupedRaw.forEach((byQ, keyRaw) => {
          let key = keyRaw || "Unspecified";
          const arr = Array.from(byQ, ([ts, val]) => ({ quarter: new Date(+ts), value: +val }))
                          .sort((a,b)=>a.quarter-b.quarter);
          if (!arr.length) return;
          const base = firstNonZero(arr);
          arr.forEach(d => {
            const p = pct(d.value, base);
            let pctVal = p==null || !Number.isFinite(p) ? 0 : p*100;
            if (pctVal > CFG.MAX_PCT) pctVal = CFG.MAX_PCT;
            if (pctVal < -CFG.MAX_PCT) pctVal = -CFG.MAX_PCT;
            d.pct = pctVal/100;
          });
          out.push({ key, values: arr, latest: arr[arr.length-1] });
        });
        return out;
      }

      const series = buildSeries();

      if (!series.length) return clearViz("No series available.");

      // Rank & TopN
      series.sort((a,b) => {
        const va = (metric==="absolute") ? a.latest.value : Math.abs(a.latest.pct || 0);
        const vb = (metric==="absolute") ? b.latest.value : Math.abs(b.latest.pct || 0);
        return d3.descending(va, vb);
      });
      let top = series.slice(0, CFG.topN);
      const rest = series.slice(CFG.topN);
      if (rest.length && metric === "absolute") {
        const byQ = new Map();
        for (const s of rest) for (const v of s.values) byQ.set(+v.quarter, (byQ.get(+v.quarter) || 0) + v.value);
        const values = Array.from(byQ, ([ts, value]) => ({ quarter: new Date(ts), value })).sort((a,b)=>a.quarter-b.quarter);
        top = top.concat([{ key: "Other", values, latest: values[values.length-1] }]);
      }
      const keys = top.map(d => d.key);

      const quarters = top[0] ? top[0].values.map(d => d.quarter) : [];
      if (!quarters.length) return clearViz("No quarters available.");

      const stackInput = quarters.map(q => {
        const row = { quarter: q };
        for (const s of top) {
          const v = s.values.find(d => +d.quarter === +q);
          let val = 0;
          if (metric==="absolute") {
            val = (v && Number.isFinite(v.value)) ? +v.value : 0;
          } else {
            const pctv = (v && Number.isFinite(v.pct)) ? v.pct : 0;
            val = Math.max(-CFG.MAX_PCT, Math.min(CFG.MAX_PCT, pctv * 100)); // percent points
          }
          row[s.key] = val;
        }
        return row;
      });

      const stack = d3.stack().keys(keys)
        .offset(metric === "pct_change" ? d3.stackOffsetDiverging : d3.stackOffsetNone);
      const layers = stack(stackInput);

      x.domain(d3.extent(quarters));
      xOverview.domain(x.domain());

      // Y domain
      let yMin = 0, yMax = 0;
      for (let L of layers) {
        for (let d of L) {
          if (Number.isFinite(d[0]) && d[0] < yMin) yMin = d[0];
          if (Number.isFinite(d[1]) && d[1] > yMax) yMax = d[1];
        }
      }
      if (metric === "pct_change") {
        const m = Math.max(Math.abs(yMin), Math.abs(yMax));
        const pad = m * 0.08 + 5;
        yMin = -m - pad;
        yMax =  m + pad;
      } else {
        if (yMin === yMax) { yMin -= 1; yMax += 1; }
      }
      y.domain([yMin, yMax]).nice();
      yOverview.domain(y.domain());

      const fillFor = (d) => colorFor(groupBy, d.key);

      // Series paths (keyed)
      const paths = gSeries.selectAll("path.layer").data(layers, d => d.key);
      paths.enter().append("path").attr("class","layer")
          .attr("fill", fillFor).attr("opacity", 0.9)
        .merge(paths).attr("fill", fillFor).attr("d", area);
      paths.exit().remove();

      xAxisG.call(d3.axisBottom(x).ticks(W < 700 ? 6 : 10));
      yAxisG.call(d3.axisLeft(y).ticks(6).tickFormat(d => metric==="absolute" ? d3.format(",")(d) : d + "%"));

      // Overview
      gOverview.selectAll("path.ov").data(layers, d=>d.key)
        .join("path").attr("class","ov").attr("fill", fillFor).attr("opacity", .6)
        .attr("d", areaOverview);

      gOverview.selectAll("g.xov").data([0]).join("g").attr("class","xov")
        .attr("transform", `translate(0,${innerHOverview})`)
        .call(d3.axisBottom(xOverview).ticks(W < 700 ? 6 : 10));

      gOverview.selectAll("g.yov").data([0]).join("g").attr("class","yov")
        .call(d3.axisLeft(yOverview).ticks(3).tickFormat(()=>""));

      // Brush default: last 5 years
      const lastQ = quarters[quarters.length - 1] || new Date(Date.UTC(2024,0,1));
      const idx0 = Math.max(0, quarters.length - 5*4);
      const x0 = xOverview(quarters[idx0] || quarters[0]);
      const x1 = xOverview(lastQ);
      const brush = d3.brushX()
        .extent([[0,0], [innerWOverview, innerHOverview]])
        .on("brush end", brushed);
      const gBrush = gOverview.selectAll("g.brush").data([0]).join("g").attr("class","brush");
      gBrush.call(brush).call(brush.move, [x0, x1]);

      renderLegend(keys, groupBy, fillFor);
      addHover(stackInput, keys, metric, groupBy, fillFor);
    }

    function clearViz(msg){
      gSeries.selectAll("*").remove();
      xAxisG.selectAll("*").remove();
      yAxisG.selectAll("*").remove();
      gOverview.selectAll("*").remove();
      container.selectAll("div.legend").remove();
      container.selectAll(".warn").remove();
      container.append("div").attr("class","warn").style("color","#ffb4b4").style("padding","8px").text(msg);
      return;
    }

    function brushed({selection}) {
      if (!selection) return;
      const inv0 = xOverview.invert(selection[0]);
      const inv1 = xOverview.invert(selection[1]);
      x.domain([inv0, inv1]);
      gSeries.selectAll("path.layer").attr("d", area);
      xAxisG.call(d3.axisBottom(x).ticks(W < 700 ? 6 : 10));
    }

    function renderLegend(keys, groupBy, fillFor) {
      // HTML legend above the chart so long sector names can wrap.
      let legend = container.select("div.legend");
      if (legend.empty()) {
        legend = container.insert("div", "svg").attr("class", "legend")
          .style("display", "flex").style("flex-wrap", "wrap").style("gap", ".35rem 1rem")
          .style("padding", "12px 16px 0").style("font-size", ".85rem").style("color", "#aab2bd");
      }
      const items = legend.selectAll("span.leg").data(keys, d => d)
        .join(enter => {
          const it = enter.append("span").attr("class", "leg")
            .style("cursor", "pointer").style("display", "inline-flex").style("align-items", "center");
          it.append("i").style("display", "inline-block").style("width", "12px").style("height", "12px")
            .style("border-radius", "2px").style("margin-right", "6px");
          it.append("span");
          return it;
        })
        .style("opacity", 1)
        .attr("title", "Click to dim or restore this series");
      items.select("i").style("background", d => fillFor({ key: d }));
      items.select("span").text(d => d);
      items.on("click", function(_, key) {
        const node = gSeries.selectAll("path.layer").filter(d => d.key === key);
        const dim = +node.attr("opacity") >= 0.4;
        node.transition().duration(160).attr("opacity", dim ? 0.2 : 0.9);
        d3.select(this).style("opacity", dim ? 0.45 : 1);
      });
    }

    function addHover(rows, keys, metric, groupBy, fillFor) {
      const bisect = d3.bisector(d => d.quarter).left;

      gSeries.selectAll("rect.hover").data([0]).join("rect")
        .attr("class","hover").attr("x",0).attr("y",0)
        .attr("width", innerW).attr("height", innerH)
        .attr("fill","transparent")
        .on("mousemove", (event) => {
          const xm = d3.pointer(event, gSeries.node())[0];
          const t = x.invert(xm);
          let i = bisect(rows, t);
          if (i >= rows.length) i = rows.length - 1;
          if (i < 0) i = 0;
          const row = rows[i];

          const lines = keys.map(k => {
            const val = row[k];
            const color = colorFor(groupBy, k);
            let txt;
            if (metric==="absolute") {
              txt = d3.format(",")(val);
            } else {
              const capped = Math.abs(val) >= CFG.MAX_PCT;
              txt = d3.format(".1f")(val) + "%" + (capped ? " (capped)" : "");
            }
            return `<div><span style="display:inline-block;width:.8rem;height:.8rem;background:${color};margin-right:.4rem;border-radius:2px"></span>${k}: <strong>${txt}</strong></div>`;
          }).join("");

          const q = row.quarter;
          tooltip.style("display","block")
            .style("left", (event.clientX + 16) + "px")
            .style("top", (event.clientY + 16) + "px")
            .html(`<div style="opacity:.85">${q.getUTCFullYear()} Q${(q.getUTCMonth()/3)+1}</div>${lines}`);
        })
        .on("mouseleave", () => tooltip.style("display","none"));
    }

    update();
    if (!regionSelect.empty()) regionSelect.on("change", update);
    if (!groupBySelect.empty()) groupBySelect.on("change", update);
    if (!metricSelect.empty()) metricSelect.on("change", update);
    d3.select("#saSelect").on("change", update);
  })
  .catch(err => {
    container.append("div").style("padding","16px").style("color","#ffb4b4")
      .text("Failed to load or render the visualization: " + err.message);
    console.error(err);
  });

})();