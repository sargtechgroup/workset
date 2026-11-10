(() => {
  const WGS84_A = 6378137;
  const WGS84_F = 1 / 298.257223563;
  const WGS84_E2 = WGS84_F * (2 - WGS84_F);
  const UTM_K0 = 0.9996;
  const WORKBOOK_SPHERE_RADIUS = 60 * 1.851995554 * 1000 * 180 / Math.PI;
  const UTM_BANDS = "CDEFGHJKLMNPQRSTUVWX";
  const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const number = (value, label) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid number.`);
    return parsed;
  };
  const radians = (degrees) => degrees * Math.PI / 180;
  const degrees = (radiansValue) => radiansValue * 180 / Math.PI;
  const wrapDegrees = (value) => ((value + 180) % 360 + 360) % 360 - 180;
  const fmt = (value, digits = 3) => Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  const coordRows = (text, labels) => {
    const rows = String(text || "").split(/\r?\n/).map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const parts = trimmed.includes(",") || trimmed.includes("\t") || trimmed.includes(";")
        ? trimmed.split(/[,\t;]+/).map((part) => part.trim())
        : trimmed.split(/\s+/);
      if (index === 0 && parts.some((part) => /[a-z#]/i.test(part))
        && parts.every((part) => !/^[+-]?(?:\d|\.\d)/.test(part))) return null;
      if (parts.length !== labels.length) throw new Error(`Line ${index + 1}: enter ${labels.join(", ")}.`);
      return parts.map((part, partIndex) => {
        if (labels[partIndex].includes("hemisphere")) {
          const hemisphere = part.toUpperCase();
          const valid = labels[partIndex].startsWith("lat") ? ["N", "S"] : labels[partIndex].startsWith("lon") ? ["E", "W"] : ["N", "S"];
          if (!valid.includes(hemisphere)) throw new Error(`Line ${index + 1}: hemisphere must be ${valid.join(" or ")}.`);
          return hemisphere;
        }
        return number(part, `Line ${index + 1} ${labels[partIndex]}`);
      });
    }).filter(Boolean);
    if (!rows.length) throw new Error("Enter at least one coordinate row.");
    return rows;
  };
  const coordinate = (lat, lon) => {
    const latitude = number(lat, "Latitude");
    const longitude = number(lon, "Longitude");
    if (latitude < -80 || latitude > 84) throw new Error("UTM latitude must be between 80°S and 84°N.");
    if (longitude < -180 || longitude > 180) throw new Error("Longitude must be between 180°W and 180°E.");
    return { lat: latitude, lon: longitude };
  };
  const zoneFor = (lat, lon) => {
    let zone = Math.floor((lon + 180) / 6) + 1;
    zone = Math.min(60, Math.max(1, zone));
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
    if (lat >= 72 && lat <= 84) {
      if (lon >= 0 && lon < 9) zone = 31;
      else if (lon < 21 && lon >= 9) zone = 33;
      else if (lon < 33 && lon >= 21) zone = 35;
      else if (lon < 42 && lon >= 33) zone = 37;
    }
    return zone;
  };
  const bandFor = (lat) => UTM_BANDS[Math.min(20, Math.floor((lat + 80) / 8))];
  const centralMeridian = (zone) => (zone - 1) * 6 - 180 + 3;

  function toUTM(latValue, lonValue, forcedZone = null) {
    const { lat, lon } = coordinate(latValue, lonValue);
    const zone = forcedZone == null ? zoneFor(lat, lon) : Math.trunc(number(forcedZone, "UTM zone"));
    if (zone < 1 || zone > 60) throw new Error("UTM zone must be from 1 through 60.");
    const phi = radians(lat);
    const lambda = radians(lon);
    const lambda0 = radians(centralMeridian(zone));
    const ePrime2 = WGS84_E2 / (1 - WGS84_E2);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const tanPhi = Math.tan(phi);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi ** 2);
    const t = tanPhi ** 2;
    const c = ePrime2 * cosPhi ** 2;
    const a = cosPhi * wrapRadians(lambda - lambda0);
    const e4 = WGS84_E2 ** 2;
    const e6 = WGS84_E2 ** 3;
    const meridian = WGS84_A * (
      (1 - WGS84_E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
      - (3 * WGS84_E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
      - (35 * e6 / 3072) * Math.sin(6 * phi)
    );
    const easting = 500000 + UTM_K0 * n * (
      a + (1 - t + c) * a ** 3 / 6
      + (5 - 18 * t + t ** 2 + 72 * c - 58 * ePrime2) * a ** 5 / 120
    );
    let northing = UTM_K0 * (
      meridian + n * tanPhi * (
        a ** 2 / 2 + (5 - t + 9 * c + 4 * c ** 2) * a ** 4 / 24
        + (61 - 58 * t + t ** 2 + 600 * c - 330 * ePrime2) * a ** 6 / 720
      )
    );
    if (lat < 0) northing += 10000000;
    return { zone, band: bandFor(lat), hemisphere: lat < 0 ? "S" : "N", easting, northing };
  }

  function inspectCoordinate(lat, lon) {
    const point = coordinate(lat, lon);
    return { ...point, ...toUTM(point.lat, point.lon) };
  }

  function wrapRadians(value) {
    return ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }

  function fromUTM(zoneValue, hemisphereValue, northingValue, eastingValue) {
    const zone = Math.trunc(number(zoneValue, "UTM zone"));
    const hemisphere = String(hemisphereValue).toUpperCase();
    const northing = number(northingValue, "Northing");
    const easting = number(eastingValue, "Easting");
    if (zone < 1 || zone > 60) throw new Error("UTM zone must be from 1 through 60.");
    if (!["N", "S"].includes(hemisphere)) throw new Error("Hemisphere must be N or S.");
    if (easting < 100000 || easting > 900000 || northing < 0 || northing > 10000000) {
      throw new Error("Easting or northing is outside the valid UTM range.");
    }
    const ePrime2 = WGS84_E2 / (1 - WGS84_E2);
    const x = easting - 500000;
    const y = northing - (hemisphere === "S" ? 10000000 : 0);
    const m = y / UTM_K0;
    const mu = m / (WGS84_A * (1 - WGS84_E2 / 4 - 3 * WGS84_E2 ** 2 / 64 - 5 * WGS84_E2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - WGS84_E2)) / (1 + Math.sqrt(1 - WGS84_E2));
    const j1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32;
    const j2 = 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32;
    const j3 = 151 * e1 ** 3 / 96;
    const j4 = 1097 * e1 ** 4 / 512;
    const fp = mu + j1 * Math.sin(2 * mu) + j2 * Math.sin(4 * mu) + j3 * Math.sin(6 * mu) + j4 * Math.sin(8 * mu);
    const sinFp = Math.sin(fp);
    const cosFp = Math.cos(fp);
    const tanFp = Math.tan(fp);
    const c1 = ePrime2 * cosFp ** 2;
    const t1 = tanFp ** 2;
    const n1 = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinFp ** 2);
    const r1 = WGS84_A * (1 - WGS84_E2) / (1 - WGS84_E2 * sinFp ** 2) ** 1.5;
    const d = x / (n1 * UTM_K0);
    const latitude = fp - (n1 * tanFp / r1) * (
      d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ePrime2) * d ** 4 / 24
      + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ePrime2 - 3 * c1 ** 2) * d ** 6 / 720
    );
    const longitude = radians(centralMeridian(zone)) + (
      d - (1 + 2 * t1 + c1) * d ** 3 / 6
      + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ePrime2 + 24 * t1 ** 2) * d ** 5 / 120
    ) / cosFp;
    const result = { lat: degrees(latitude), lon: wrapDegrees(degrees(longitude)) };
    if (result.lat < -80.1 || result.lat > 84.1) throw new Error("The result is outside the UTM latitude coverage.");
    return result;
  }

  function greatCircleDistance(lat1, lon1, lat2, lon2) {
    const phi1 = radians(lat1);
    const phi2 = radians(lat2);
    const dPhi = radians(lat2 - lat1);
    const dLambda = radians(lon2 - lon1);
    const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return 2 * WORKBOOK_SPHERE_RADIUS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }

  function table(headers, rows) {
    return `<div class="table-wrap gps-result-table"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${escape(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const formField = (label, name, input, full = false) => `<label class="gps-field ${full ? "gps-field-full" : ""}"><span>${escape(label)}</span>${input}</label>`;
  const input = (name, placeholder, type = "text", attrs = "") => `<input class="form-input" name="${name}" type="${type}" placeholder="${escape(placeholder)}" ${attrs}>`;
  const textarea = (name, placeholder, rows = 5) => `<textarea class="form-textarea" name="${name}" rows="${rows}" placeholder="${escape(placeholder)}"></textarea>`;
  const form = (mode, fields, button = "Calculate") => `<form class="gps-calc-form" data-gps-calc-form="${mode}"><div class="gps-form-grid">${fields.join("")}</div><button class="button button-primary" type="submit">${escape(button)}</button><div class="gps-calc-output" aria-live="polite"></div></form>`;
  const pointColumns = {
    coordinate: [["latitude", "Latitude", "number"], ["longitude", "Longitude", "number"]],
    utm: [["zone", "Zone", "number"], ["hemisphere", "Hemisphere (N/S)", "text"], ["northing", "Northing (m)", "number"], ["easting", "Easting (m)", "number"]],
    bulk: [["chainage", "Chainage (m)", "number"], ["latitude", "Latitude", "number"], ["longitude", "Longitude", "number"]],
    dms: [["latDegrees", "Lat °", "number"], ["latMinutes", "Lat ′", "number"], ["latSeconds", "Lat ″", "number"], ["latHemisphere", "N/S", "text"], ["lonDegrees", "Lon °", "number"], ["lonMinutes", "Lon ′", "number"], ["lonSeconds", "Lon ″", "number"], ["lonHemisphere", "E/W", "text"]],
  };
  const pointEntry = (columns, placeholder, rows = 5) => {
    const columnFields = pointColumns[columns];
    return `<div class="gps-point-entry gps-field gps-field-full">
      <span>Coordinate entry</span>
      <div class="gps-entry-toggle"><button type="button" class="gps-entry-mode active" data-gps-entry-mode="paste" aria-pressed="true">Paste rows</button><button type="button" class="gps-entry-mode" data-gps-entry-mode="columns" aria-pressed="false">Enter in columns</button></div>
      <input type="hidden" name="entryMode" value="paste">
      <div data-gps-entry-view="paste"><textarea class="form-textarea" name="points" rows="${rows}" placeholder="${escape(placeholder)}"></textarea><span class="form-hint">Paste rows using commas, tabs, or spaces, in the column order shown.</span></div>
      <div data-gps-entry-view="columns" hidden><div class="gps-column-table-scroll"><table class="gps-column-table"><thead><tr><th>Point</th>${columnFields.map(([, label]) => `<th>${escape(label)}</th>`).join("")}</tr></thead><tbody>${Array.from({ length: Math.min(rows, 5) }, (_, index) => columnEntryRow(columnFields, index)).join("")}</tbody></table></div><button type="button" class="button button-outline gps-add-row" data-gps-add-row>Add row</button><span class="form-hint">Leave unused rows blank. Use Add row for larger routes.</span></div>
    </div>`;
  };
  const columnEntryRow = (fields, index) => `<tr data-gps-column-row><td>${index + 1}</td>${fields.map(([name, label, type]) => `<td><input class="form-input" type="${type}" ${type === "number" ? 'step="any"' : ""} name="column_${name}" aria-label="${escape(label)} ${index + 1}" placeholder="${type === "text" ? "N / S" : ""}"></td>`).join("")}</tr>`;
  const modes = [
    ["distance", "Route distances"],
    ["to-utm", "Lat/Lon → UTM"],
    ["from-utm", "UTM → Lat/Lon"],
    ["dms", "DMS ↔ decimal"],
    ["projection", "Point projection"],
    ["bulk", "Bulk projections"],
    ["qa", "Coordinate QA"],
    ["sun", "Sunrise / sunset"],
  ];

  function render(activeMode, jobs = [], selectedJobId = "", autoAdd = true) {
    const tabs = modes.map(([id, label]) => `<button type="button" class="gps-calc-tab ${id === activeMode ? "active" : ""}" data-gps-calculator="${id}" aria-pressed="${id === activeMode}">${escape(label)}</button>`).join("");
    const calculator = calculatorMarkup(activeMode);
    const jobOptions = jobs.map((job) => `<option value="${escape(job.id)}" ${job.id === selectedJobId ? "selected" : ""}>${escape(job.name)} · ${escape(job.location)}</option>`).join("");
    const mapOptions = `<div class="gps-calc-map-options"><label for="gps-calculation-job">Add calculated points to job</label><select class="form-input" id="gps-calculation-job" ${jobs.length ? "" : "disabled"}><option value="">Select a job</option>${jobOptions}</select><label class="gps-calc-auto-add"><input type="checkbox" id="gps-calculation-auto-add" ${autoAdd ? "checked" : ""} ${jobs.length ? "" : "disabled"}> Automatically add coordinate results to this job's GPS map</label></div>`;
    return `<section class="card panel gps-calculator"><div class="panel-head"><div><h2 class="panel-title">GPS Calculations</h2><p class="panel-subtitle">Coordinate, route, projection, and solar calculations from the Coordinate King workbook.</p></div></div>${mapOptions}<div class="gps-calc-tabs" role="tablist" aria-label="GPS calculation type">${tabs}</div><div class="gps-calc-workspace">${calculator}</div></section>`;
  }

  function calculatorMarkup(mode) {
    if (mode === "distance") return `<h3>Route distances</h3><p class="gps-calc-help">Enter decimal latitude and longitude coordinates in route order. Distances use the same spherical scale as the source workbook.</p>${form(mode, [pointEntry("coordinate", "35.7586, -95.3073\n35.7587, -95.3072\n35.7590, -95.3069", 8)])}`;
    if (mode === "to-utm") return `<h3>Latitude / longitude to UTM</h3><p class="gps-calc-help">Enter decimal latitude and longitude. Western longitudes must be negative.</p>${form(mode, [pointEntry("coordinate", "55.04115775, -119.6264358\n56.38607219, -116.79709947", 6)])}`;
    if (mode === "from-utm") return `<h3>UTM to latitude / longitude</h3><p class="gps-calc-help">Enter UTM zone, hemisphere, northing, and easting for each point.</p>${form(mode, [pointEntry("utm", "11, N, 6102524.689, 332182.939\n11, N, 6249068.204, 512528.013", 6)])}`;
    if (mode === "dms") return `<h3>Degrees, minutes, seconds and decimal degrees</h3><p class="gps-calc-help">Choose a conversion direction and enter signed decimal degrees or DMS coordinates with hemisphere.</p>
      <div class="gps-dms-grid">
        ${form("dms-to-decimal", [pointEntry("dms", "35, 45, 31.2, N, 95, 18, 26.4, W", 4)], "Convert DMS to decimal")}
        ${form("decimal-to-dms", [pointEntry("coordinate", "35.758667, -95.307333", 4)], "Convert decimal to DMS")}
      </div>`;
    if (mode === "projection") return `<h3>Project points along a reference line</h3><p class="gps-calc-help">Define a line using its start and end coordinates, then enter signed distances from the start in meters.</p>${form(mode, [
      formField("Start latitude", "startLat", input("startLat", "28.942352255", "number", 'step="any" required')),
      formField("Start longitude", "startLon", input("startLon", "47.899620421", "number", 'step="any" required')),
      formField("End latitude", "endLat", input("endLat", "28.942426419", "number", 'step="any" required')),
      formField("End longitude", "endLon", input("endLon", "47.899615963", "number", 'step="any" required')),
      formField("Distances from start · meters, comma separated", "offsets", input("offsets", "0, 4, 14", "text", "required"), true),
    ])}`;
    if (mode === "bulk") return `<h3>Bulk chainage projections</h3><p class="gps-calc-help">Enter GPS fixes in chainage order as chainage in meters, latitude, longitude. Regular stations are interpolated in the local UTM grid between supplied fixes.</p>${form(mode, [
      pointEntry("bulk", "0, 28.928698826, 47.968313472\n1, 28.928698146, 47.968298609\n2, 28.928688826, 47.968297455", 8),
      formField("Station interval · meters", "interval", input("interval", "1", "number", 'min="0.001" step="any" required')),
    ])}`;
    if (mode === "qa") return `<h3>Coordinate round-trip error</h3><p class="gps-calc-help">Convert each latitude/longitude to UTM and back, then compare the returned coordinate with the original.</p>${form(mode, [pointEntry("coordinate", "56.3860721875, -116.7970994683\n55.04115775, -119.6264358", 6)])}`;
    if (mode === "sun") return `<h3>Sunrise / sunset</h3><p class="gps-calc-help">Approximate sunrise and sunset using the NOAA solar-position method. Enter the local UTC offset; enable daylight time if applicable.</p>${form(mode, [
      formField("Date", "date", input("date", "", "date", 'required')),
      formField("Latitude", "lat", input("lat", "31.71518", "number", 'step="any" required')),
      formField("Longitude", "lon", input("lon", "-101.93789", "number", 'step="any" required')),
      formField("UTC offset · hours", "offset", input("offset", "-6", "number", 'min="-12" max="14" step="0.5" required')),
      formField("Daylight time", "dst", `<select class="form-input" name="dst"><option value="0">No</option><option value="1">Yes (+1 hour)</option></select>`),
    ])}`;
    return `<h3>GPS calculations</h3><p class="gps-calc-help">Choose a calculator above.</p>`;
  }

  function preparePointInput(mode, data) {
    if (data.get("entryMode") === "columns") {
      const columns = ({
        "distance": pointColumns.coordinate,
        "to-utm": pointColumns.coordinate,
        "from-utm": pointColumns.utm,
        "dms-to-decimal": pointColumns.dms,
        "decimal-to-dms": pointColumns.coordinate,
        "bulk": pointColumns.bulk,
        "qa": pointColumns.coordinate,
      })[mode];
      if (!columns) throw new Error("Column entry is not available for this calculation.");
      const values = columns.map(([name]) => data.getAll(`column_${name}`));
      const rows = [];
      const rowCount = Math.max(...values.map((column) => column.length));
      for (let index = 0; index < rowCount; index += 1) {
        const row = values.map((column) => String(column[index] ?? "").trim());
        if (row.every((value) => !value)) continue;
        if (row.some((value) => !value)) {
          throw new Error(`Point ${index + 1}: complete every column or leave the entire row blank.`);
        }
        rows.push(row.join(", "));
      }
      if (!rows.length) throw new Error("Enter at least one coordinate row.");
      data.set("points", rows.join("\n"));
    }
  }

  function calculate(mode, data) {
    preparePointInput(mode, data);
    if (mode === "distance") return distanceResults(data);
    if (mode === "to-utm") return toUTMResults(data);
    if (mode === "from-utm") return fromUTMResults(data);
    if (mode === "dms-to-decimal") return dmsToDecimalResults(data);
    if (mode === "decimal-to-dms") return decimalToDMSResults(data);
    if (mode === "projection") return projectionResults(data);
    if (mode === "bulk") return bulkResults(data);
    if (mode === "qa") return qaResults(data);
    if (mode === "sun") return sunResults(data);
    throw new Error("Choose a GPS calculator.");
  }

  function mapCoordinates(mode, data) {
    preparePointInput(mode, data);
    if (mode === "distance" || mode === "to-utm" || mode === "decimal-to-dms") {
      return coordRows(data.get("points"), ["latitude", "longitude"])
        .map(([lat, lon]) => coordinate(lat, lon));
    }
    if (mode === "qa") {
      return coordRows(data.get("points"), ["latitude", "longitude"]).map(([lat, lon]) => {
        const utm = toUTM(lat, lon);
        return fromUTM(utm.zone, utm.hemisphere, utm.northing, utm.easting);
      });
    }
    if (mode === "from-utm") {
      return coordRows(data.get("points"), ["zone", "hemisphere", "northing", "easting"])
        .map(([zone, hemisphere, northing, easting]) => fromUTM(zone, hemisphere, northing, easting));
    }
    if (mode === "dms-to-decimal") return dmsCoordinates(data);
    if (mode === "projection") return projectionPoints(data).points;
    if (mode === "bulk") return bulkPoints(data).points;
    return [];
  }

  function distanceResults(data) {
    const points = coordRows(data.get("points"), ["latitude", "longitude"]).map(([lat, lon]) => coordinate(lat, lon));
    let meters = 0;
    const rows = points.map((point, index) => {
      const segment = index ? greatCircleDistance(points[index - 1].lat, points[index - 1].lon, point.lat, point.lon) : 0;
      meters += segment;
      return [index + 1, fmt(point.lat, 8), fmt(point.lon, 8), fmt(segment), fmt(segment / 1000, 6), fmt(segment / 1609.344, 6), fmt(segment * 3.280839895), fmt(meters * 3.280839895), fmt(meters), Math.round(meters), fmt(meters / 1609.344, 6)];
    });
    return `<p class="gps-result-summary">Total route distance: <strong>${fmt(meters)} m</strong> · ${fmt(meters / 1000, 4)} km · ${fmt(meters / 1609.344, 4)} mi · ${fmt(meters * 3.280839895, 2)} ft</p>${table(["Point", "Latitude", "Longitude", "Segment m", "km", "mi", "ft", "Cumulative ft", "Cumulative m", "Rounded m", "Cumulative mi"], rows)}`;
  }

  function toUTMResults(data) {
    const points = coordRows(data.get("points"), ["latitude", "longitude"]);
    return table(["Point", "Latitude", "Longitude", "Zone", "Band", "Hemisphere", "Easting (m)", "Northing (m)"], points.map(([lat, lon], index) => {
      const result = toUTM(lat, lon);
      return [index + 1, fmt(lat, 8), fmt(lon, 8), result.zone, result.band, result.hemisphere, fmt(result.easting, 3), fmt(result.northing, 3)];
    }));
  }

  function fromUTMResults(data) {
    const points = coordRows(data.get("points"), ["zone", "hemisphere", "northing", "easting"]);
    return table(["Point", "Zone", "Hemisphere", "Northing (m)", "Easting (m)", "Latitude", "Longitude"], points.map(([zone, hemisphere, northing, easting], index) => {
      const result = fromUTM(zone, hemisphere, northing, easting);
      return [index + 1, zone, hemisphere, fmt(northing, 3), fmt(easting, 3), fmt(result.lat, 9), fmt(result.lon, 9)];
    }));
  }

  function dmsToDecimalResults(data) {
    const points = dmsCoordinates(data);
    return table(["Point", "Latitude DD", "Longitude DD"], points.map((point, index) => [
      index + 1, fmt(point.lat, 9), fmt(point.lon, 9),
    ]));
  }

  function dmsCoordinates(data) {
    const points = coordRows(data.get("points"), ["lat degrees", "lat minutes", "lat seconds", "lat hemisphere", "lon degrees", "lon minutes", "lon seconds", "lon hemisphere"]);
    const convert = (degreesValue, minutesValue, secondsValue, hemisphere) => {
      if (minutesValue < 0 || minutesValue >= 60 || secondsValue < 0 || secondsValue >= 60) throw new Error("Minutes and seconds must be at least 0 and less than 60.");
      const magnitude = Math.abs(degreesValue) + minutesValue / 60 + secondsValue / 3600;
      return hemisphere === "S" || hemisphere === "W" || degreesValue < 0 ? -magnitude : magnitude;
    };
    return points.map((point, index) => {
      const latitude = convert(point[0], point[1], point[2], point[3]);
      const longitude = convert(point[4], point[5], point[6], point[7]);
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error(`Line ${index + 1}: latitude or longitude is out of range.`);
      return coordinate(latitude, longitude);
    });
  }

  function decimalToDMSResults(data) {
    const points = coordRows(data.get("points"), ["latitude", "longitude"]);
    const dms = (value, positive, negative) => {
      const hemisphere = value < 0 ? negative : positive;
      const absolute = Math.abs(value);
      const deg = Math.floor(absolute);
      const minuteValue = (absolute - deg) * 60;
      const min = Math.floor(minuteValue);
      const sec = (minuteValue - min) * 60;
      return `${deg}° ${min}′ ${fmt(sec, 4)}″ ${hemisphere}`;
    };
    return table(["Point", "Latitude DMS", "Longitude DMS"], points.map(([lat, lon], index) => [
      index + 1, dms(lat, "N", "S"), dms(lon, "E", "W"),
    ]));
  }

  function projectionResults(data) {
    const result = projectionPoints(data);
    return `<p class="gps-result-summary">Reference line: ${fmt(result.lineLength)} m · bearing ${fmt(result.bearing, 3)}°</p>${table(["Point", "Offset from start (m)", "Easting (m)", "Northing (m)", "Latitude", "Longitude"], result.points.map((point, index) => [
      index + 1, fmt(point.offset), fmt(point.easting, 3), fmt(point.northing, 3), fmt(point.lat, 9), fmt(point.lon, 9),
    ]))}`;
  }

  function projectionPoints(data) {
    const start = coordinate(data.get("startLat"), data.get("startLon"));
    const end = coordinate(data.get("endLat"), data.get("endLon"));
    const startUtm = toUTM(start.lat, start.lon);
    const endUtm = toUTM(end.lat, end.lon, startUtm.zone);
    if (startUtm.hemisphere !== endUtm.hemisphere) throw new Error("Reference points must be in the same hemisphere.");
    const eastDelta = endUtm.easting - startUtm.easting;
    const northDelta = endUtm.northing - startUtm.northing;
    const lineLength = Math.hypot(eastDelta, northDelta);
    if (lineLength < 0.001) throw new Error("The reference points must be at least 1 mm apart.");
    const offsets = String(data.get("offsets") || "").split(/[,\s;]+/).filter(Boolean).map((value) => number(value, "Offset"));
    if (!offsets.length || offsets.length > 2000) throw new Error("Enter between 1 and 2,000 offsets.");
    const points = offsets.map((offset) => {
      const easting = startUtm.easting + eastDelta / lineLength * offset;
      const northing = startUtm.northing + northDelta / lineLength * offset;
      return { offset, easting, northing, ...fromUTM(startUtm.zone, startUtm.hemisphere, northing, easting) };
    });
    return {
      lineLength,
      bearing: (Math.atan2(eastDelta, northDelta) * 180 / Math.PI + 360) % 360,
      points,
    };
  }

  function bulkResults(data) {
    const result = bulkPoints(data);
    return `<p class="gps-result-summary">Interpolated ${result.points.length} stations in UTM zone ${result.zone}${result.hemisphere} using WGS-84.</p>${table(["Chainage (m)", "Zone", "Northing (m)", "Easting (m)", "Latitude", "Longitude"], result.points.map((point) => [
      fmt(point.chainage, 3), result.zone, fmt(point.northing, 3), fmt(point.easting, 3), fmt(point.lat, 9), fmt(point.lon, 9),
    ]))}`;
  }

  function bulkPoints(data) {
    const source = coordRows(data.get("points"), ["chainage", "latitude", "longitude"]).map(([chainage, lat, lon]) => {
      const point = coordinate(lat, lon);
      return { chainage, ...point };
    }).sort((a, b) => a.chainage - b.chainage);
    if (source.length < 2) throw new Error("Enter at least two GPS fixes.");
    if (source.some((point, index) => index && point.chainage === source[index - 1].chainage)) throw new Error("Each GPS fix must have a unique chainage.");
    const firstUtm = toUTM(source[0].lat, source[0].lon);
    const projected = source.map((point) => {
      const utm = toUTM(point.lat, point.lon, firstUtm.zone);
      if (utm.hemisphere !== firstUtm.hemisphere) throw new Error("All GPS fixes must be in the same hemisphere.");
      return { ...point, ...utm };
    });
    const interval = number(data.get("interval"), "Station interval");
    if (interval <= 0) throw new Error("Station interval must be greater than zero.");
    const firstStation = Math.ceil((projected[0].chainage - 1e-9) / interval) * interval;
    const lastStation = Math.floor((projected[projected.length - 1].chainage + 1e-9) / interval) * interval;
    const count = Math.floor((lastStation - firstStation) / interval) + 1;
    if (count < 1 || count > 2000) throw new Error("The selected interval would create too many stations (limit 2,000).");
    const points = Array.from({ length: count }, (_, index) => {
      const chainage = firstStation + index * interval;
      let nextIndex = projected.findIndex((point) => point.chainage >= chainage);
      if (nextIndex < 0) nextIndex = projected.length - 1;
      const before = projected[Math.max(0, nextIndex - (projected[nextIndex].chainage > chainage ? 1 : 0))];
      const after = projected[nextIndex];
      const fraction = after.chainage === before.chainage ? 0 : (chainage - before.chainage) / (after.chainage - before.chainage);
      const easting = before.easting + (after.easting - before.easting) * fraction;
      const northing = before.northing + (after.northing - before.northing) * fraction;
      const position = fromUTM(firstUtm.zone, firstUtm.hemisphere, northing, easting);
      return { chainage, easting, northing, ...position };
    });
    return { zone: firstUtm.zone, hemisphere: firstUtm.hemisphere, points };
  }

  function qaResults(data) {
    const points = coordRows(data.get("points"), ["latitude", "longitude"]);
    return table(["Point", "Input latitude", "Input longitude", "Zone", "Easting (m)", "Northing (m)", "Returned latitude", "Returned longitude", "Latitude error (m)", "Longitude error (m)", "Total error (m)"], points.map(([lat, lon], index) => {
      const utm = toUTM(lat, lon);
      const returned = fromUTM(utm.zone, utm.hemisphere, utm.northing, utm.easting);
      const latError = (returned.lat - lat) * 111132;
      const lonError = (returned.lon - lon) * 111320 * Math.cos(radians(lat));
      return [index + 1, fmt(lat, 9), fmt(lon, 9), `${utm.zone}${utm.band}`, fmt(utm.easting, 3), fmt(utm.northing, 3), fmt(returned.lat, 9), fmt(returned.lon, 9), fmt(latError, 6), fmt(lonError, 6), fmt(Math.hypot(latError, lonError), 6)];
    }));
  }

  function sunResults(data) {
    const date = String(data.get("date") || "");
    const latitude = number(data.get("lat"), "Latitude");
    const longitude = number(data.get("lon"), "Longitude");
    const utcOffset = number(data.get("offset"), "UTC offset");
    const dst = Number(data.get("dst")) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) throw new Error("Enter a valid date.");
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error("Latitude or longitude is out of range.");
    if (utcOffset < -12 || utcOffset > 14) throw new Error("UTC offset must be between -12 and +14 hours.");
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const day = Number(date.slice(8, 10));
    const selectedDate = new Date(Date.UTC(year, month - 1, day));
    if (selectedDate.getUTCFullYear() !== year || selectedDate.getUTCMonth() !== month - 1 || selectedDate.getUTCDate() !== day) throw new Error("Enter a valid date.");
    const dayOfYear = Math.floor((selectedDate.getTime() - Date.UTC(year, 0, 0)) / 86400000);
    const sunrise = solarEvent(dayOfYear, latitude, longitude, true);
    const sunset = solarEvent(dayOfYear, latitude, longitude, false);
    if (sunrise === null || sunset === null) return `<p class="gps-result-summary">The sun does not cross the horizon on this date at the supplied location (polar day/night).</p>`;
    const localSunrise = sunrise + utcOffset + dst;
    const localSunset = sunset + utcOffset + dst;
    const utcText = (hours) => `${formatClock(hours)} UTC`;
    const localText = (hours) => `${formatClock(hours)}${dayLabel(hours)} local`;
    return `<div class="gps-solar-results"><article><span>Sunrise · local</span><strong>${localText(localSunrise)}</strong><small>${utcText(sunrise)}</small></article><article><span>Sunset · local</span><strong>${localText(localSunset)}</strong><small>${utcText(sunset)}</small></article></div><p class="gps-calc-help">Approximate solar times; local times use UTC${utcOffset >= 0 ? "+" : ""}${utcOffset}${dst ? " plus daylight time" : ""}. Results do not account for terrain or local horizon obstruction.</p>`;
  }

  function solarEvent(day, latitude, longitude, isSunrise) {
    const lngHour = longitude / 15;
    const t = day + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const meanAnomaly = 0.9856 * t - 3.289;
    let trueLongitude = meanAnomaly + 1.916 * Math.sin(radians(meanAnomaly)) + 0.020 * Math.sin(2 * radians(meanAnomaly)) + 282.634;
    trueLongitude = ((trueLongitude % 360) + 360) % 360;
    let rightAscension = degrees(Math.atan(0.91764 * Math.tan(radians(trueLongitude))));
    rightAscension = ((rightAscension % 360) + 360) % 360;
    rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
    rightAscension /= 15;
    const sinDeclination = 0.39782 * Math.sin(radians(trueLongitude));
    const cosDeclination = Math.cos(Math.asin(sinDeclination));
    const cosHourAngle = (Math.cos(radians(90.833)) - sinDeclination * Math.sin(radians(latitude)))
      / (cosDeclination * Math.cos(radians(latitude)));
    if (cosHourAngle > 1 || cosHourAngle < -1) return null;
    let hourAngle = degrees(Math.acos(cosHourAngle));
    if (isSunrise) hourAngle = 360 - hourAngle;
    hourAngle /= 15;
    const localMeanTime = hourAngle + rightAscension - 0.06571 * t - 6.622;
    return ((localMeanTime - lngHour) % 24 + 24) % 24;
  }

  function formatClock(hours) {
    const normalized = ((hours % 24) + 24) % 24;
    const totalMinutes = Math.round(normalized * 60) % 1440;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const dayLabel = (hours) => hours < 0 ? " (previous day)" : hours >= 24 ? " (next day)" : "";

  window.GPSCalculations = { render, calculate, mapCoordinates, inspectCoordinate };
})();
