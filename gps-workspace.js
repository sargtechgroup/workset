(() => {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const fmt = (value, digits = 6) => Number(value).toLocaleString("en-CA", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  const initialWorkspace = () => ({ version: 1, features: [], center: null, zoom: null, baseLayer: "street" });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const uuid = () => window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `gps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  function workspaceFor(job) {
    const saved = job?.gpsWorkspace;
    if (saved && Array.isArray(saved.features)) return { ...initialWorkspace(), ...saved, features: saved.features };
    if (Number.isFinite(job?.siteCoordinate?.lat) && Number.isFinite(job?.siteCoordinate?.lon)) {
      return {
        ...initialWorkspace(),
        center: [job.siteCoordinate.lat, job.siteCoordinate.lon],
        zoom: 14,
        features: [{ id: `site-${job.id}`, type: "point", name: "Project site", lat: job.siteCoordinate.lat, lon: job.siteCoordinate.lon }],
      };
    }
    return initialWorkspace();
  }

  function render(jobs, selectedJobId) {
    const selectedJob = jobs.find((job) => job.id === selectedJobId);
    const options = jobs.map((job) => `<option value="${escape(job.id)}" ${job.id === selectedJobId ? "selected" : ""}>${escape(job.name)} · ${escape(job.location)}</option>`).join("");
    return `<section class="gps-workspace-page">
      <section class="card panel gps-workspace-heading"><div><h2 class="panel-title">GPS workspace</h2><p class="panel-subtitle">Map a job, add route points and areas, and save field measurements with the project.</p></div>
        <label class="gps-job-picker"><span>Project</span><select id="gps-workspace-job" class="form-input" ${jobs.length ? "" : "disabled"}><option value="">Select a project</option>${options}</select></label>
      </section>
      ${selectedJob ? `<div class="gps-workspace-jobline"><strong>${escape(selectedJob.name)}</strong><span>${escape(selectedJob.location)} · ${escape(selectedJob.client)}</span><button type="button" class="button button-primary" data-gps-save>Save to job</button><span class="gps-save-indicator" role="status">Saved with this project as you edit</span></div>
        <div class="gps-workspace-layout">
          <div class="gps-map-shell"><div id="gps-workspace-map" class="gps-map" role="application" aria-label="Interactive project map"></div><div class="gps-map-summary" data-gps-map-summary></div><div class="gps-map-error" data-gps-map-error role="status" hidden></div><div class="gps-map-legend"><span>Street and satellite basemaps</span><span>NRCan elevation lookup</span></div></div>
          <aside class="card panel gps-workspace-tools">
            <h3>Map tools</h3>
            <p class="gps-workspace-hint">Click the map to add route points, or draw an area by placing at least three vertices.</p>
            <div class="gps-map-mode" role="group" aria-label="Map drawing mode"><button type="button" class="button button-outline selected" data-gps-mode="point" aria-pressed="true">Add route points</button><button type="button" class="button button-outline" data-gps-mode="area" aria-pressed="false">Draw an area</button></div>
            <div class="gps-draw-actions" hidden><span data-gps-draft-count>0 vertices</span><button type="button" class="button button-primary" data-gps-finish-area disabled>Finish area</button><button type="button" class="text-link" data-gps-cancel-area>Cancel</button></div>
            <form class="gps-coordinate-form" data-gps-coordinate-form><strong>Add a point by coordinates</strong><label>Latitude<input class="form-input" name="latitude" type="number" step="any" min="-90" max="90" required></label><label>Longitude<input class="form-input" name="longitude" type="number" step="any" min="-180" max="180" required></label><button class="button button-outline" type="submit">Add point</button><span class="gps-workspace-error" data-gps-coordinate-error role="status"></span></form>
            <div class="gps-workspace-feature-list"><h3>Saved map features <span data-gps-feature-count></span></h3><div data-gps-feature-list></div></div>
            <div data-gps-feature-details class="gps-feature-details"><p class="gps-workspace-hint">Select a map feature to view and edit its details.</p></div>
            <p class="gps-data-notice">Map tile requests send the viewed map area to the selected basemap provider (OpenStreetMap or Esri). Elevation lookup sends selected coordinates to Natural Resources Canada; elevations and area measurements are approximate, not survey measurements. Land ownership is not verified by this map: check the official provincial or territorial registry before relying on a Crown/private designation. Legal descriptions and any user-recorded land status are not certified. <a href="https://search.open.canada.ca/data/?search_text=Crown%20land%20tenure" target="_blank" rel="noopener">Browse public land datasets</a> (coverage varies); <a href="https://www.ontario.ca/page/crown-land-use-policy-atlas" target="_blank" rel="noopener">Ontario Crown Land Use Policy Atlas</a> (Ontario policy reference only, not title verification).</p>
          </aside>
        </div>`
        : `<section class="card panel"><div class="empty-state"><strong>${jobs.length ? "Select a project" : "Create a project first"}</strong>${jobs.length ? "Choose a project above to open its saved GPS workspace." : "Create a project to start mapping and saving GPS data."}</div></section>`}
    </section>`;
  }

  function distanceMeters(a, b) {
    const radians = (value) => value * Math.PI / 180;
    const radius = 6371008.8;
    const dLat = radians(b.lat - a.lat);
    const dLon = radians(b.lon - a.lon);
    const lat1 = radians(a.lat);
    const lat2 = radians(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(Math.min(1, h)));
  }

  function areaMetrics(vertices) {
    if (vertices.length < 3) return { area: 0, perimeter: 0 };
    const meanLatitude = vertices.reduce((sum, point) => sum + point.lat, 0) / vertices.length;
    const radians = Math.PI / 180;
    const x = (longitude) => longitude * radians * 6378137 * Math.cos(meanLatitude * radians);
    const y = (latitude) => latitude * radians * 6378137;
    let twiceArea = 0;
    let perimeter = 0;
    vertices.forEach((point, index) => {
      const next = vertices[(index + 1) % vertices.length];
      twiceArea += x(point.lon) * y(next.lat) - x(next.lon) * y(point.lat);
      perimeter += distanceMeters(point, next);
    });
    return { area: Math.abs(twiceArea) / 2, perimeter };
  }

  function mount(container, job, onChange, onSave) {
    const mapElement = container.querySelector("#gps-workspace-map");
    if (!mapElement || !job) return;
    if (!window.L) {
      mapElement.innerHTML = `<p class="gps-map-error">The map library did not load. Check your internet connection and reload this page.</p>`;
      return;
    }
    const workspace = workspaceFor(job);
    const features = workspace.features;
    let selectedId = features[0]?.id || "";
    let drawingMode = "point";
    let draftVertices = [];
    let draftLayers = [];
    const layers = new Map();
    const map = L.map(mapElement, { preferCanvas: true }).setView(
      workspace.center || [56, -106],
      workspace.zoom || 3,
    );
    const streetLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    });
    const satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    });
    const baseLayers = { "Street map": streetLayer, "Satellite imagery": satelliteLayer };
    const activeBaseLayer = workspace.baseLayer === "satellite" ? satelliteLayer : streetLayer;
    activeBaseLayer.addTo(map);
    L.control.layers(baseLayers, null, { position: "topright", collapsed: true }).addTo(map);
    const showTileError = () => {
      const error = container.querySelector("[data-gps-map-error]");
      error.hidden = false;
      error.textContent = "Some map tiles could not be loaded. Check your internet connection.";
    };
    const clearTileError = () => {
      const error = container.querySelector("[data-gps-map-error]");
      error.hidden = true;
      error.textContent = "";
    };
    Object.values(baseLayers).forEach((layer) => {
      layer.on("tileerror", showTileError);
      layer.on("tileload", clearTileError);
    });
    map.on("baselayerchange", (event) => {
      workspace.baseLayer = event.layer === satelliteLayer ? "satellite" : "street";
      persist();
    });
    const featureLayer = L.featureGroup().addTo(map);

    const persist = () => {
      workspace.center = [map.getCenter().lat, map.getCenter().lng];
      workspace.zoom = map.getZoom();
      workspace.updatedAt = new Date().toISOString();
      onChange(clone(workspace));
    };
    const featureInfo = (feature) => {
      if (feature.type === "point") {
        const utm = window.GPSCalculations.inspectCoordinate(feature.lat, feature.lon);
        return `<div class="gps-popup"><strong>${escape(feature.name)}</strong><span>Lat ${fmt(feature.lat, 8)} · Lon ${fmt(feature.lon, 8)}</span><span>UTM ${utm.zone}${utm.hemisphere} · E ${fmt(utm.easting, 2)} m · N ${fmt(utm.northing, 2)} m</span><span>${feature.elevationM == null ? "Elevation not looked up" : `Elevation ${fmt(feature.elevationM, 1)} m`}</span></div>`;
      }
      const metrics = areaMetrics(feature.vertices);
      const landStatus = ({
        "crown-user": "Crown land · user-recorded, unverified",
        "private-user": "Private land · user-recorded, unverified",
        "other-user": "Other / reserved · user-recorded, unverified",
      })[feature.landStatus] || "Land status not verified";
      return `<div class="gps-popup"><strong>${escape(feature.name)}</strong><span>${fmt(metrics.area, 1)} m² · ${fmt(metrics.area / 10000, 4)} ha · ${fmt(metrics.perimeter, 1)} m perimeter</span><span>${escape(feature.legalDescription || "Legal description not entered")}</span><span>${landStatus}</span></div>`;
    };
    const renderFeatures = () => {
      featureLayer.clearLayers();
      layers.clear();
      const points = features.filter((feature) => feature.type === "point");
      if (points.length > 1) {
        const route = L.polyline(points.map((point) => [point.lat, point.lon]), { color: "#1f5147", weight: 4, opacity: 0.8 });
        route.addTo(featureLayer);
      }
      features.forEach((feature) => {
        let layer;
        if (feature.type === "point") {
          layer = L.circleMarker([feature.lat, feature.lon], {
            radius: feature.id === selectedId ? 9 : 7,
            color: "#fff",
            weight: 2,
            fillColor: feature.id === selectedId ? "#c7763d" : "#1f5147",
            fillOpacity: 1,
          });
        } else {
          layer = L.polygon(feature.vertices.map((point) => [point.lat, point.lon]), {
            color: feature.id === selectedId ? "#c7763d" : "#1f5147",
            fillColor: feature.id === selectedId ? "#e8a375" : "#7eb19d",
            fillOpacity: 0.25,
            weight: 3,
          });
        }
        layer.bindPopup(featureInfo(feature));
        layer.on("click", (event) => {
          L.DomEvent.stopPropagation(event);
          selectedId = feature.id;
          updateSidebar();
          renderFeatures();
          layer.openPopup();
        });
        layer.addTo(featureLayer);
        layers.set(feature.id, layer);
      });
      const savedPoints = features.filter((feature) => feature.type === "point");
      const routeDistance = savedPoints.slice(1).reduce((sum, point, index) => sum + distanceMeters(savedPoints[index], point), 0);
      container.querySelector("[data-gps-map-summary]").textContent = `${savedPoints.length} route point${savedPoints.length === 1 ? "" : "s"} · ${fmt(routeDistance, 1)} m route · ${features.filter((feature) => feature.type === "area").length} area${features.filter((feature) => feature.type === "area").length === 1 ? "" : "s"}`;
    };
    const updateSidebar = () => {
      container.querySelector("[data-gps-feature-count]").textContent = `(${features.length})`;
      const list = container.querySelector("[data-gps-feature-list]");
      list.innerHTML = features.length ? features.map((feature, index) => {
        const description = feature.type === "point"
          ? `${fmt(feature.lat, 6)}, ${fmt(feature.lon, 6)}`
          : `${feature.vertices.length} vertices · ${fmt(areaMetrics(feature.vertices).area / 10000, 3)} ha`;
        return `<div class="gps-feature-item ${feature.id === selectedId ? "selected" : ""}"><button type="button" data-gps-select="${escape(feature.id)}"><strong>${escape(feature.name || `${feature.type} ${index + 1}`)}</strong><span>${description}</span></button><button type="button" class="gps-feature-delete" data-gps-delete="${escape(feature.id)}" aria-label="Delete ${escape(feature.name)}">×</button></div>`;
      }).join("") : `<p class="gps-workspace-hint">No map features saved yet.</p>`;
      const details = container.querySelector("[data-gps-feature-details]");
      const feature = features.find((item) => item.id === selectedId);
      if (!feature) {
        details.innerHTML = `<p class="gps-workspace-hint">Select a map feature to view and edit its details.</p>`;
        return;
      }
      const heading = `<label>Feature name<input class="form-input" name="featureName" value="${escape(feature.name)}" maxlength="80"></label>`;
      if (feature.type === "point") {
        const utm = window.GPSCalculations.inspectCoordinate(feature.lat, feature.lon);
        details.innerHTML = `<h3>Point details</h3>${heading}<dl class="gps-detail-grid"><dt>Latitude</dt><dd>${fmt(feature.lat, 8)}°</dd><dt>Longitude</dt><dd>${fmt(feature.lon, 8)}°</dd><dt>UTM</dt><dd>${utm.zone}${utm.hemisphere} · E ${fmt(utm.easting, 2)} m · N ${fmt(utm.northing, 2)} m</dd><dt>Elevation</dt><dd>${feature.elevationM == null ? "Not checked" : `${fmt(feature.elevationM, 1)} m (NRCan)`}</dd></dl><button type="button" class="button button-outline" data-gps-elevation="${escape(feature.id)}">Look up elevation</button><span class="gps-elevation-message" data-gps-elevation-message>${escape(feature.elevationError || "")}</span>`;
      } else {
        const metrics = areaMetrics(feature.vertices);
        const coordinates = feature.vertices.map((point, index) => {
          const utm = window.GPSCalculations.inspectCoordinate(point.lat, point.lon);
          const elevation = point.elevationM == null ? "elevation not checked" : `${fmt(point.elevationM, 1)} m`;
          return `<li>${index + 1}. ${fmt(point.lat, 6)}°, ${fmt(point.lon, 6)}° · UTM ${utm.zone}${utm.hemisphere}, E ${fmt(utm.easting, 1)} m, N ${fmt(utm.northing, 1)} m · ${elevation}</li>`;
        }).join("");
        details.innerHTML = `<h3>Area details</h3>${heading}<dl class="gps-detail-grid"><dt>Area</dt><dd>${fmt(metrics.area, 1)} m² · ${fmt(metrics.area / 10000, 4)} ha · ${fmt(metrics.area / 4046.8564224, 4)} acres</dd><dt>Perimeter</dt><dd>${fmt(metrics.perimeter, 1)} m</dd><dt>Vertices</dt><dd>${feature.vertices.length}</dd><dt>Elevation range / mean</dt><dd>${elevationStats(feature.vertices)}</dd></dl><details class="gps-area-vertices"><summary>Vertex coordinates, UTM & elevations</summary><ol>${coordinates}</ol></details><button type="button" class="button button-outline" data-gps-area-elevation="${escape(feature.id)}">Look up vertex elevations</button><span class="gps-elevation-message" role="status">${escape(feature.elevationError || "")}</span><label>Legal land description<input class="form-input" name="legalDescription" value="${escape(feature.legalDescription || "")}" placeholder="Enter the description from the survey or land-title record"></label><label>Land status<select class="form-input" name="landStatus"><option value="unverified" ${!feature.landStatus || feature.landStatus === "unverified" ? "selected" : ""}>Not verified</option><option value="crown-user" ${feature.landStatus === "crown-user" ? "selected" : ""}>Crown land · user-recorded</option><option value="private-user" ${feature.landStatus === "private-user" ? "selected" : ""}>Private land · user-recorded</option><option value="other-user" ${feature.landStatus === "other-user" ? "selected" : ""}>Other / reserved · user-recorded</option></select></label><label>Registry / source note<textarea class="form-textarea" name="landSource" rows="2" placeholder="Registry, parcel ID, source date, or verification notes">${escape(feature.landSource || "")}</textarea></label><p class="gps-land-warning">Status is not checked against title records. A user-recorded status is not independently verified.</p>`;
      }
    };
    const updateModeButtons = () => {
      container.querySelectorAll("[data-gps-mode]").forEach((button) => {
        const active = button.dataset.gpsMode === drawingMode;
        button.classList.toggle("selected", active);
        button.setAttribute("aria-pressed", String(active));
      });
      container.querySelector(".gps-draw-actions").hidden = drawingMode !== "area";
    };
    const clearDraft = () => {
      draftVertices = [];
      draftLayers.forEach((layer) => map.removeLayer(layer));
      draftLayers = [];
      container.querySelector("[data-gps-draft-count]").textContent = "0 vertices";
      container.querySelector("[data-gps-finish-area]").disabled = true;
    };
    const addPoint = (lat, lon) => {
      if (features.length >= 500) throw new Error("A GPS workspace can contain up to 500 map features.");
      const coordinate = window.GPSCalculations.inspectCoordinate(lat, lon);
      const point = {
        id: uuid(),
        type: "point",
        name: `Point ${features.filter((feature) => feature.type === "point").length + 1}`,
        lat: coordinate.lat,
        lon: coordinate.lon,
      };
      features.push(point);
      selectedId = point.id;
      renderFeatures();
      updateSidebar();
      persist();
      map.setView([point.lat, point.lon], Math.max(map.getZoom(), 12));
    };
    const onMapClick = (event) => {
      if (drawingMode === "point") {
        const error = container.querySelector("[data-gps-coordinate-error]");
        error.textContent = "";
        try {
          addPoint(event.latlng.lat, event.latlng.lng);
        } catch (issue) {
          error.textContent = issue.message || "Could not add that map point.";
        }
        return;
      }
      const vertex = { lat: event.latlng.lat, lon: event.latlng.lng };
      draftVertices.push(vertex);
      const marker = L.circleMarker([vertex.lat, vertex.lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#c7763d", fillOpacity: 1 }).addTo(map);
      draftLayers.push(marker);
      if (draftVertices.length > 1) {
        const line = L.polyline(draftVertices.map((point) => [point.lat, point.lon]), { color: "#c7763d", dashArray: "5 5" }).addTo(map);
        draftLayers.push(line);
      }
      container.querySelector("[data-gps-draft-count]").textContent = `${draftVertices.length} ${draftVertices.length === 1 ? "vertex" : "vertices"}`;
      container.querySelector("[data-gps-finish-area]").disabled = draftVertices.length < 3;
    };

    map.on("click", onMapClick);
    map.on("moveend", persist);
    renderFeatures();
    updateSidebar();
    updateModeButtons();
    window.setTimeout(() => map.invalidateSize(), 0);

    container.addEventListener("click", async (event) => {
      const modeButton = event.target.closest("[data-gps-mode]");
      if (modeButton) {
        if (drawingMode === "area" && modeButton.dataset.gpsMode !== "area") clearDraft();
        drawingMode = modeButton.dataset.gpsMode;
        updateModeButtons();
        return;
      }
      if (event.target.closest("[data-gps-cancel-area]")) {
        clearDraft();
        return;
      }
      if (event.target.closest("[data-gps-finish-area]")) {
        if (draftVertices.length < 3) return;
        if (features.length >= 500) {
          container.querySelector("[data-gps-coordinate-error]").textContent = "A GPS workspace can contain up to 500 map features.";
          return;
        }
        const area = {
          id: uuid(),
          type: "area",
          name: `Area ${features.filter((feature) => feature.type === "area").length + 1}`,
          vertices: draftVertices.map((vertex) => ({ ...vertex })),
          legalDescription: "",
          landStatus: "unverified",
          landSource: "",
        };
        features.push(area);
        selectedId = area.id;
        clearDraft();
        drawingMode = "point";
        updateModeButtons();
        renderFeatures();
        updateSidebar();
        persist();
        return;
      }
      const select = event.target.closest("[data-gps-select]");
      if (select) {
        selectedId = select.dataset.gpsSelect;
        updateSidebar();
        renderFeatures();
        const layer = layers.get(selectedId);
        if (layer) map.fitBounds(layer.getBounds ? layer.getBounds().pad(0.7) : L.latLngBounds([layer.getLatLng()]).pad(1.5), { maxZoom: 15 });
        return;
      }
      const remove = event.target.closest("[data-gps-delete]");
      if (remove) {
        const index = features.findIndex((feature) => feature.id === remove.dataset.gpsDelete);
        if (index >= 0) features.splice(index, 1);
        selectedId = features[0]?.id || "";
        renderFeatures();
        updateSidebar();
        persist();
        return;
      }
      const elevationButton = event.target.closest("[data-gps-elevation]");
      const areaElevationButton = event.target.closest("[data-gps-area-elevation]");
      if (elevationButton || areaElevationButton) {
        const featureId = (elevationButton || areaElevationButton).dataset.gpsElevation
          || areaElevationButton.dataset.gpsAreaElevation;
        const feature = features.find((item) => item.id === featureId);
        if (!feature) return;
        const vertices = feature.type === "point" ? [feature] : feature.vertices;
        if (vertices.length > 30) {
          feature.elevationError = "Elevation lookup is limited to 30 vertices per area.";
          updateSidebar();
          persist();
          return;
        }
        const button = elevationButton || areaElevationButton;
        button.disabled = true;
        button.textContent = "Looking up…";
        feature.elevationError = "";
        updateSidebar();
        const activeButton = container.querySelector(`[data-gps-elevation="${featureId}"],[data-gps-area-elevation="${featureId}"]`);
        if (activeButton) {
          activeButton.disabled = true;
          activeButton.textContent = "Looking up…";
        }
        try {
          for (const point of vertices) {
            const url = new URL("https://geogratis.gc.ca/services/elevation/cdem/altitude");
            url.searchParams.set("lat", point.lat);
            url.searchParams.set("lon", point.lon);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Elevation service returned HTTP ${response.status}.`);
            const result = await response.json();
            if (!Number.isFinite(Number(result.altitude))) throw new Error("The elevation service returned no elevation for this location.");
            point.elevationM = Number(result.altitude);
          }
          delete feature.elevationError;
          persist();
          renderFeatures();
          updateSidebar();
        } catch (error) {
          console.error("Could not retrieve Canadian elevation data.", error);
          feature.elevationError = error.message || "Elevation lookup failed. Try again later.";
          updateSidebar();
          persist();
        }
        return;
      }
      if (event.target.closest("[data-gps-save]")) {
        persist();
        onSave();
      }
    });

    container.addEventListener("input", (event) => {
      if (event.target.name === "featureName") {
        const feature = features.find((item) => item.id === selectedId);
        if (feature) {
          feature.name = event.target.value.slice(0, 80);
          const selectionStart = event.target.selectionStart;
          renderFeatures();
          updateSidebar();
          const input = container.querySelector('[name="featureName"]');
          input.focus();
          input.setSelectionRange(selectionStart, selectionStart);
          persist();
        }
      } else if (event.target.name === "landSource") {
        const feature = features.find((item) => item.id === selectedId);
        if (feature?.type === "area") {
          feature.landSource = event.target.value;
          persist();
        }
      }
    });

    container.addEventListener("change", (event) => {
      const feature = features.find((item) => item.id === selectedId);
      if (!feature) return;
      if (event.target.name === "legalDescription" && feature.type === "area") {
        feature.legalDescription = event.target.value;
        renderFeatures();
        persist();
      } else if (event.target.name === "landStatus" && feature.type === "area") {
        feature.landStatus = event.target.value;
        renderFeatures();
        persist();
      }
    });
    container.querySelector("[data-gps-coordinate-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      container.querySelector("[data-gps-coordinate-error]").textContent = "";
      try {
        addPoint(data.get("latitude"), data.get("longitude"));
        event.currentTarget.reset();
      } catch (error) {
        container.querySelector("[data-gps-coordinate-error]").textContent = error.message || "Could not add that coordinate.";
      }
    });
    let mounted = true;
    return () => {
      if (!mounted) return;
      mounted = false;
      map.remove();
    };
  }

  function elevationStats(vertices) {
    const available = vertices.map((point) => point.elevationM).filter(Number.isFinite);
    if (!available.length) return "Not checked";
    const mean = available.reduce((sum, value) => sum + value, 0) / available.length;
    return `${fmt(Math.min(...available), 1)} / ${fmt(mean, 1)} / ${fmt(Math.max(...available), 1)} m (${available.length}/${vertices.length} vertices)`;
  }

  function addCalculatedPoints(job, points, calculationMode) {
    if (!job) throw new Error("Select a job before adding GPS calculations to its map.");
    if (!Array.isArray(points) || !points.length) throw new Error("This calculation did not produce any map coordinates.");
    const normalized = points.map((point, index) => {
      const lat = Number(point.lat);
      const lon = Number(point.lon);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        throw new Error(`Calculated point ${index + 1} has invalid latitude or longitude.`);
      }
      return { ...point, lat, lon };
    });
    const workspace = workspaceFor(job);
    if (workspace.features.length + normalized.length > 500) {
      throw new Error(`This job's map can hold up to 500 features. ${normalized.length} calculated points would exceed that limit.`);
    }
    const labels = {
      distance: "Route distances",
      "to-utm": "Latitude / longitude to UTM",
      "from-utm": "UTM to latitude / longitude",
      "dms-to-decimal": "DMS to decimal",
      "decimal-to-dms": "Decimal to DMS",
      projection: "Point projection",
      bulk: "Bulk projections",
      qa: "Coordinate QA",
    };
    const routeGroup = `calculation-${uuid()}`;
    const label = labels[calculationMode] || "GPS calculation";
    workspace.features.push(...normalized.map((point, index) => {
      const positionLabel = Number.isFinite(point.chainage)
        ? `Station ${fmt(point.chainage, 3)} m`
        : Number.isFinite(point.offset) ? `Offset ${fmt(point.offset, 3)} m` : `Point ${index + 1}`;
      return {
        id: uuid(),
        type: "point",
        name: `${label} · ${positionLabel}`,
        lat: point.lat,
        lon: point.lon,
        routeGroup,
        calculationMode,
      };
    }));
    workspace.center = [
      normalized.reduce((sum, point) => sum + point.lat, 0) / normalized.length,
      normalized.reduce((sum, point) => sum + point.lon, 0) / normalized.length,
    ];
    workspace.zoom = Math.max(workspace.zoom || 3, 12);
    workspace.updatedAt = new Date().toISOString();
    job.gpsWorkspace = workspace;
    return normalized.length;
  }

  window.GPSWorkspace = { render, mount, addCalculatedPoints };
})();
