/**
 * Agroptics zone demo
 * Loads a ready index GeoTIFF (single band) and splits it into
 * the number of management zones the user picks.
 */
(function () {
    'use strict';

    var DEFAULT_TIF = 'https://satalite-images-04-2026.s3.eu-north-1.amazonaws.com/Individual/amhashem85-gmail.com/Dina_Farms/Takwa_1_correct/851e9092-44e4-49c8-9e89-d6974b9bf03c/processed/2026-06-26_084002/NDVI.tif';
    var ACRES_PER_M2 = 0.000247105;
    var CLASS_NAMES = [null, 'Low', 'Medium', 'High'];
    var CLASS_COLORS = [
        null,
        { r: 215, g: 48, b: 39, hex: '#d73027' },
        { r: 255, g: 255, b: 191, hex: '#ffffbf' },
        { r: 26, g: 152, b: 80, hex: '#1a9850' }
    ];
    var RDYLGN = [
        [215, 48, 39],
        [252, 141, 89],
        [254, 224, 139],
        [255, 255, 191],
        [217, 239, 139],
        [145, 207, 96],
        [26, 152, 80]
    ];

    var state = {
        map: null,
        ndviLayer: null,
        zoneLayer: null,
        width: 0,
        height: 0,
        ndvi: null,
        valid: null,
        bounds: null,
        bbox: null,
        sourceProj: 'EPSG:32613',
        pixelWidth: 3,
        pixelHeight: 3,
        stats: null,
        features: [],
        regenTimer: null
    };

    function $(id) {
        return document.getElementById(id);
    }

    function setMessage(text) {
        var el = $('mapMessage');
        if (!text) {
            el.classList.add('hidden');
            return;
        }
        el.textContent = text;
        el.classList.remove('hidden');
    }

    function initMap() {
        state.map = L.map('map', {
            zoomControl: false,
            attributionControl: true
        }).setView([38.0376, -103.6887], 16);
        L.control.zoom({ position: 'bottomright' }).addTo(state.map);
        setTimeout(function () { state.map.invalidateSize(); }, 0);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri',
            maxZoom: 19
        }).addTo(state.map);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19
        }).addTo(state.map);
    }

    function defineUtm(code) {
        var m = String(code).match(/EPSG:(326|327)(\d{2})/);
        if (!m) return;
        proj4.defs(code, '+proj=utm +zone=' + parseInt(m[2], 10) + (m[1] === '327' ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs');
    }

    function bboxToLeaflet(bbox, sourceProj) {
        defineUtm(sourceProj);
        if (Math.abs(bbox[0]) > 180 || Math.abs(bbox[1]) > 90) {
            var sw = proj4(sourceProj, 'EPSG:4326', [bbox[0], bbox[1]]);
            var ne = proj4(sourceProj, 'EPSG:4326', [bbox[2], bbox[3]]);
            return [[sw[1], sw[0]], [ne[1], ne[0]]];
        }
        return [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    }

    function pixelCornerToLngLat(col, row) {
        var x = state.bbox[0] + col * state.pixelWidth;
        var y = state.bbox[3] - row * state.pixelHeight;
        if (Math.abs(state.bbox[0]) > 180) {
            var ll = proj4(state.sourceProj, 'EPSG:4326', [x, y]);
            return [ll[0], ll[1]];
        }
        return [x, y];
    }

    /* Same RdYlGn interpolation as GTAgropticsLeaflet.rdylgnColor */
    function rdylgnColor(t) {
        t = Math.max(0, Math.min(1, t));
        var index = t * (RDYLGN.length - 1);
        var i = Math.floor(index);
        var f = index - i;
        if (i >= RDYLGN.length - 1) {
            return { r: RDYLGN[6][0], g: RDYLGN[6][1], b: RDYLGN[6][2] };
        }
        var c1 = RDYLGN[i];
        var c2 = RDYLGN[i + 1];
        return {
            r: Math.round(c1[0] + f * (c2[0] - c1[0])),
            g: Math.round(c1[1] + f * (c2[1] - c1[1])),
            b: Math.round(c1[2] + f * (c2[2] - c1[2]))
        };
    }

    async function parseGeoTIFF(buffer, fileName) {
        var tiff = await GeoTIFF.fromArrayBuffer(buffer);
        var image = await tiff.getImage();
        var width = image.getWidth();
        var height = image.getHeight();
        var rasters = await image.readRasters();
        var bbox = image.getBoundingBox();
        var geoKeys = {};
        try { geoKeys = image.getGeoKeys() || {}; } catch (e) { geoKeys = {}; }

        var sourceProj = 'EPSG:32613';
        if (geoKeys.ProjectedCSTypeGeoKey) sourceProj = 'EPSG:' + geoKeys.ProjectedCSTypeGeoKey;
        else if (geoKeys.GeographicTypeGeoKey) sourceProj = 'EPSG:' + geoKeys.GeographicTypeGeoKey;

        var band = rasters[0];
        var valuesGrid = new Float32Array(width * height);
        var valid = new Uint8Array(width * height);
        var min = Infinity, max = -Infinity, values = [];

        for (var i = 0; i < width * height; i++) {
            var v = Number(band[i]);
            if (!isFinite(v)) {
                valuesGrid[i] = NaN;
                continue;
            }
            valuesGrid[i] = v;
            valid[i] = 1;
            if (v < min) min = v;
            if (v > max) max = v;
            values.push(v);
        }
        if (!values.length) throw new Error('No valid index pixels.');

        state.width = width;
        state.height = height;
        state.ndvi = valuesGrid;
        state.valid = valid;
        state.bbox = bbox;
        state.sourceProj = sourceProj;
        state.pixelWidth = (bbox[2] - bbox[0]) / width;
        state.pixelHeight = (bbox[3] - bbox[1]) / height;
        state.bounds = bboxToLeaflet(bbox, sourceProj);
        state.stats = { min: min, max: max, values: values, fileName: fileName };

        state.map.fitBounds(state.bounds, { padding: [30, 30], maxZoom: 18 });
        state.map.invalidateSize();
        setMessage('');
        await generateZones();
    }

    function zoneCount() {
        var n = Number($('zoneCount').value);
        if (n !== 2 && n !== 3 && n !== 4 && n !== 5) n = 3;
        return n;
    }

    function tableBreaks(n) {
        if (n === 3) return [0.4, 0.7];
        var breaks = [];
        for (var i = 1; i < n; i++) breaks.push(i / n);
        return breaks;
    }

    function equalIntervalBreaks(min, max, n) {
        var step = (max - min) / n || 0;
        var breaks = [];
        for (var i = 1; i < n; i++) breaks.push(min + step * i);
        return breaks;
    }

    function chooseBreaks(method, n) {
        if (method === 'quantile') return quantileBreaks(state.stats.values, n);
        if (method === 'equal') return equalIntervalBreaks(state.stats.min, state.stats.max, n);
        if (method === 'table') return tableBreaks(n);
        var breaks = jenksBreaks(state.stats.values, n);
        if (!breaks.length) return quantileBreaks(state.stats.values, n);
        return breaks;
    }

    function classBounds(method) {
        if (method === 'table') return { min: 0, max: 1 };
        return { min: state.stats.min, max: state.stats.max };
    }

    function methodLabel(method) {
        if (method === 'quantile') return 'Quantile';
        if (method === 'equal') return 'Equal interval';
        if (method === 'table') return 'Reclassify by table';
        return 'Natural Breaks';
    }

    function zoneStyle(z, n) {
        if (n === 3) return CLASS_COLORS[z];
        var t = n <= 1 ? 1 : (z - 1) / (n - 1);
        var c = rdylgnColor(t);
        var hex = '#' + [c.r, c.g, c.b].map(function (x) {
            return ('0' + x.toString(16)).slice(-2);
        }).join('');
        return { r: c.r, g: c.g, b: c.b, hex: hex };
    }

    function zoneName(z, n) {
        if (n === 3) return CLASS_NAMES[z];
        if (n === 2) return z === 1 ? 'Low' : 'High';
        return 'Zone ' + z;
    }

    function showClassOverlay(grid, n) {
        if (!state.ndvi || !state.bounds) return;
        if (state.ndviLayer) {
            state.map.removeLayer(state.ndviLayer);
            state.ndviLayer = null;
        }
        var canvas = document.createElement('canvas');
        canvas.width = state.width;
        canvas.height = state.height;
        var ctx = canvas.getContext('2d');
        var img = ctx.createImageData(state.width, state.height);
        var colors = [];
        for (var z = 1; z <= n; z++) colors[z] = zoneStyle(z, n);
        for (var i = 0; i < grid.length; i++) {
            var o = i * 4;
            var cls = grid[i];
            if (!cls || !colors[cls]) {
                img.data[o + 3] = 0;
                continue;
            }
            img.data[o] = colors[cls].r;
            img.data[o + 1] = colors[cls].g;
            img.data[o + 2] = colors[cls].b;
            img.data[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        state.ndviLayer = L.imageOverlay(canvas.toDataURL('image/png'), state.bounds, {
            opacity: 0.85,
            interactive: false
        }).addTo(state.map);
        applyLayers();
    }

    function uniqueSorted(arr) {
        return arr.filter(function (v, i, a) { return i === 0 || v !== a[i - 1]; });
    }

    function quantileBreaks(values, nClasses) {
        var sorted = values.slice().sort(function (a, b) { return a - b; });
        var breaks = [];
        for (var i = 1; i < nClasses; i++) {
            var idx = Math.min(sorted.length - 1, Math.round((i / nClasses) * (sorted.length - 1)));
            breaks.push(sorted[idx]);
        }
        return uniqueSorted(breaks).sort(function (a, b) { return a - b; });
    }

    function jenksBreaks(values, nClasses) {
        var data = values.slice();
        if (data.length > 1600) {
            var step = data.length / 1600;
            data = [];
            for (var s = 0; s < 1600; s++) data.push(values[Math.floor(s * step)]);
        }
        data.sort(function (a, b) { return a - b; });
        var n = data.length;
        nClasses = Math.max(2, Math.min(nClasses, n));
        var lowerClassLimits = [];
        var varianceCombinations = [];
        var i, j;
        for (i = 0; i <= n; i++) {
            lowerClassLimits[i] = [];
            varianceCombinations[i] = [];
            for (j = 0; j <= nClasses; j++) {
                lowerClassLimits[i][j] = 0;
                varianceCombinations[i][j] = (i === 0 || j === 0) ? 0 : Infinity;
            }
        }
        for (i = 1; i <= nClasses; i++) {
            lowerClassLimits[1][i] = 1;
            varianceCombinations[1][i] = 0;
        }
        for (var l = 2; l <= n; l++) {
            var sum = 0, sumSquares = 0, w = 0;
            for (var m = 1; m <= l; m++) {
                var i4 = l - m + 1;
                var val = data[i4 - 1];
                sum += val;
                sumSquares += val * val;
                w++;
                var variance = sumSquares - (sum * sum) / w;
                var i3 = i4 - 1;
                if (i3 !== 0) {
                    for (j = 2; j <= nClasses; j++) {
                        if (varianceCombinations[l][j] >= variance + varianceCombinations[i3][j - 1]) {
                            lowerClassLimits[l][j] = i4;
                            varianceCombinations[l][j] = variance + varianceCombinations[i3][j - 1];
                        }
                    }
                }
            }
            lowerClassLimits[l][1] = 1;
            varianceCombinations[l][1] = sumSquares - (sum * sum) / w;
        }
        var kclass = new Array(nClasses);
        kclass[nClasses - 1] = data[n - 1];
        var k = n;
        for (j = nClasses; j >= 2; j--) {
            var id = lowerClassLimits[k][j] - 2;
            kclass[j - 2] = data[Math.max(0, id)];
            k = lowerClassLimits[k][j] - 1;
        }
        return uniqueSorted(kclass.slice(0, nClasses - 1)).sort(function (a, b) { return a - b; });
    }

    function classFromValue(v, breaks) {
        for (var i = 0; i < breaks.length; i++) {
            if (v < breaks[i]) return i + 1;
        }
        return breaks.length + 1;
    }

    function classifyRaster(breaks) {
        var classified = new Int16Array(state.ndvi.length);
        for (var i = 0; i < state.ndvi.length; i++) {
            classified[i] = state.valid[i] ? classFromValue(state.ndvi[i], breaks) : 0;
        }
        return classified;
    }

    function pixelAreaAcres() {
        return Math.abs(state.pixelWidth * state.pixelHeight) * ACRES_PER_M2;
    }

    function sieveSmallComponents(grid, minAcres) {
        if (!(minAcres > 0)) return grid;
        var w = state.width;
        var h = state.height;
        var minPixels = Math.max(1, Math.round(minAcres / pixelAreaAcres()));
        for (var pass = 0; pass < 8; pass++) {
            var labels = new Int32Array(w * h);
            var sizes = [0];
            var clsOf = [0];
            var current = 0;
            for (var i = 0; i < w * h; i++) {
                if (grid[i] <= 0 || labels[i]) continue;
                current++;
                var cls = grid[i];
                clsOf[current] = cls;
                var size = 0;
                var stack = [i];
                labels[i] = current;
                while (stack.length) {
                    var idx = stack.pop();
                    size++;
                    var r = (idx / w) | 0;
                    var c = idx % w;
                    var nbs = [idx - 1, idx + 1, idx - w, idx + w];
                    var ok = [c > 0, c < w - 1, r > 0, r < h - 1];
                    for (var n = 0; n < 4; n++) {
                        if (!ok[n]) continue;
                        var ni = nbs[n];
                        if (!labels[ni] && grid[ni] === cls) {
                            labels[ni] = current;
                            stack.push(ni);
                        }
                    }
                }
                sizes[current] = size;
            }
            var small = [];
            for (var lab = 1; lab <= current; lab++) {
                if (sizes[lab] < minPixels) small.push(lab);
            }
            if (!small.length) break;
            small.sort(function (a, b) { return sizes[a] - sizes[b]; });
            small.forEach(function (lab) {
                var votes = {};
                for (var p = 0; p < w * h; p++) {
                    if (labels[p] !== lab) continue;
                    var rr = (p / w) | 0;
                    var cc = p % w;
                    [[cc - 1, rr], [cc + 1, rr], [cc, rr - 1], [cc, rr + 1]].forEach(function (xy) {
                        if (xy[0] < 0 || xy[1] < 0 || xy[0] >= w || xy[1] >= h) return;
                        var other = grid[xy[1] * w + xy[0]];
                        if (other > 0 && other !== clsOf[lab]) votes[other] = (votes[other] || 0) + 1;
                    });
                }
                var best = 0, bestN = 0;
                Object.keys(votes).forEach(function (k) {
                    if (votes[k] > bestN) {
                        bestN = votes[k];
                        best = Number(k);
                    }
                });
                if (!best) return;
                for (var q = 0; q < w * h; q++) {
                    if (labels[q] === lab) grid[q] = best;
                }
            });
        }
        return grid;
    }

    function collectRings(grid, cls) {
        var w = state.width;
        var h = state.height;
        var edges = new Map();
        function add(x1, y1, x2, y2) {
            var k = x1 + ',' + y1;
            if (!edges.has(k)) edges.set(k, []);
            edges.get(k).push([x2, y2]);
        }
        function outside(c, r) {
            if (c < 0 || r < 0 || c >= w || r >= h) return true;
            return grid[r * w + c] !== cls;
        }
        for (var r = 0; r < h; r++) {
            for (var c = 0; c < w; c++) {
                if (grid[r * w + c] !== cls) continue;
                if (outside(c, r - 1)) add(c, r, c + 1, r);
                if (outside(c + 1, r)) add(c + 1, r, c + 1, r + 1);
                if (outside(c, r + 1)) add(c + 1, r + 1, c, r + 1);
                if (outside(c - 1, r)) add(c, r + 1, c, r);
            }
        }
        var used = new Set();
        var rings = [];
        edges.forEach(function (dests, startKey) {
            dests.forEach(function (dest) {
                var s = startKey.split(',').map(Number);
                var ekey = s[0] + ',' + s[1] + ',' + dest[0] + ',' + dest[1];
                if (used.has(ekey)) return;
                var ring = [[s[0], s[1]]];
                var cx = dest[0], cy = dest[1], px = s[0], py = s[1];
                used.add(ekey);
                ring.push([cx, cy]);
                var guard = 0;
                while ((cx !== s[0] || cy !== s[1]) && guard++ < 200000) {
                    var opts = edges.get(cx + ',' + cy) || [];
                    var next = null;
                    for (var i = 0; i < opts.length; i++) {
                        var n1 = opts[i];
                        var nk = cx + ',' + cy + ',' + n1[0] + ',' + n1[1];
                        if (!used.has(nk) && !(n1[0] === px && n1[1] === py)) { next = n1; break; }
                    }
                    if (!next) {
                        for (var j = 0; j < opts.length; j++) {
                            var n2 = opts[j];
                            var nk2 = cx + ',' + cy + ',' + n2[0] + ',' + n2[1];
                            if (!used.has(nk2)) { next = n2; break; }
                        }
                    }
                    if (!next) break;
                    used.add(cx + ',' + cy + ',' + next[0] + ',' + next[1]);
                    px = cx; py = cy;
                    cx = next[0]; cy = next[1];
                    ring.push([cx, cy]);
                }
                if (ring.length >= 4) rings.push(ring);
            });
        });
        return rings;
    }

    function closeRing(ring) {
        var a = ring[0], b = ring[ring.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
        return ring;
    }

    function signedArea(ring) {
        var a = 0;
        for (var i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        return a / 2;
    }

    function pointInRing(pt, ring) {
        var x = pt[0], y = pt[1], inside = false;
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
        }
        return inside;
    }

    function ringsToPolygons(ringsLngLat) {
        var prepared = ringsLngLat.map(function (r) {
            var ring = closeRing(r.slice());
            return { ring: ring, abs: Math.abs(signedArea(ring)) };
        }).filter(function (r) { return r.abs > 1e-14; });
        prepared.sort(function (a, b) { return b.abs - a.abs; });
        var used = new Array(prepared.length).fill(false);
        var polygons = [];
        for (var i = 0; i < prepared.length; i++) {
            if (used[i]) continue;
            var outer = prepared[i].ring;
            if (signedArea(outer) < 0) outer = outer.slice().reverse();
            used[i] = true;
            var holes = [];
            for (var j = i + 1; j < prepared.length; j++) {
                if (used[j]) continue;
                if (pointInRing(prepared[j].ring[0], outer)) {
                    var hole = prepared[j].ring;
                    if (signedArea(hole) > 0) hole = hole.slice().reverse();
                    holes.push(hole);
                    used[j] = true;
                }
            }
            polygons.push([outer].concat(holes));
        }
        return polygons;
    }

    function classRange(z, breaks, bounds) {
        var n = breaks.length + 1;
        if (z <= 1) return { min: bounds.min, max: breaks[0] };
        if (z >= n) return { min: breaks[breaks.length - 1], max: bounds.max };
        return { min: breaks[z - 2], max: breaks[z - 1] };
    }

    function zoneAggregate(grid, agg) {
        var buckets = {};
        for (var i = 0; i < grid.length; i++) {
            var cls = grid[i];
            if (!cls) continue;
            if (!buckets[cls]) buckets[cls] = [];
            buckets[cls].push(state.ndvi[i]);
        }
        var out = {};
        Object.keys(buckets).forEach(function (key) {
            var vals = buckets[key];
            if (agg === 'median') {
                vals.sort(function (a, b) { return a - b; });
                var mid = (vals.length - 1) / 2;
                out[key] = (vals[Math.floor(mid)] + vals[Math.ceil(mid)]) / 2;
            } else {
                var sum = 0;
                for (var j = 0; j < vals.length; j++) sum += vals[j];
                out[key] = sum / vals.length;
            }
        });
        return out;
    }

    function polygonizeZones(grid, breaks, method, aggValues) {
        var features = [];
        var n = breaks.length + 1;
        for (var z = 1; z <= n; z++) {
            var pixelRings = collectRings(grid, z);
            if (!pixelRings.length) continue;
            var llRings = pixelRings.map(function (ring) {
                return ring.map(function (p) { return pixelCornerToLngLat(p[0], p[1]); });
            });
            var polys = ringsToPolygons(llRings);
            var range = classRange(z, breaks, classBounds(method));
            var color = zoneStyle(z, n);
            var name = zoneName(z, n);
            var agg = aggValues[z];
            polys.forEach(function (coords) {
                var geom = { type: 'Polygon', coordinates: coords };
                var areaM2 = 0;
                try { areaM2 = turf.area(turf.feature(geom)); } catch (e) { areaM2 = 0; }
                features.push({
                    type: 'Feature',
                    properties: {
                        zone: z,
                        label: name,
                        ndvi_min: Number(range.min.toFixed(4)),
                        ndvi_max: Number(range.max.toFixed(4)),
                        ndvi_value: agg == null ? null : Number(agg.toFixed(4)),
                        area_acres: Number((areaM2 * ACRES_PER_M2).toFixed(4)),
                        color: color.hex
                    },
                    geometry: geom
                });
            });
        }
        return features;
    }

    function renderZones(features) {
        if (state.zoneLayer) {
            state.map.removeLayer(state.zoneLayer);
            state.zoneLayer = null;
        }
        state.features = features;
        state.zoneLayer = L.geoJSON({ type: 'FeatureCollection', features: features }, {
            style: function (feature) {
                var color = feature.properties.color || '#333';
                return {
                    color: color,
                    weight: 1.5,
                    fillColor: color,
                    fillOpacity: 0.28
                };
            }
        }).addTo(state.map);
        $('exportGeojsonBtn').disabled = features.length === 0;
        applyLayers();
        updateChart(features);
    }

    function applyLayers() {
        toggleMapLayer(state.ndviLayer, $('layerImage') && $('layerImage').checked);
        toggleMapLayer(state.zoneLayer, $('layerPolygons') && $('layerPolygons').checked);
        if (state.zoneLayer && state.map.hasLayer(state.zoneLayer)) state.zoneLayer.bringToFront();
    }

    function toggleMapLayer(layer, on) {
        if (!layer || !state.map) return;
        if (on) {
            if (!state.map.hasLayer(layer)) layer.addTo(state.map);
        } else if (state.map.hasLayer(layer)) {
            state.map.removeLayer(layer);
        }
    }

    function fmtAcres(v) {
        if (v >= 100) return String(Math.round(v));
        if (v >= 10) return v.toFixed(1);
        return v.toFixed(2);
    }

    function updateChart(features) {
        var host = $('zoneChart');
        var list = $('chartList');
        host.innerHTML = '';
        list.innerHTML = '';
        var groups = {};
        features.forEach(function (f) {
            var z = f.properties.zone;
            if (!groups[z]) {
                groups[z] = {
                    zone: z,
                    label: f.properties.label,
                    color: f.properties.color,
                    acres: 0,
                    value: f.properties.ndvi_value
                };
            }
            groups[z].acres += Number(f.properties.area_acres) || 0;
        });
        var slices = Object.keys(groups).map(function (k) { return groups[k]; });
        slices.sort(function (a, b) { return a.zone - b.zone; });
        var total = slices.reduce(function (sum, s) { return sum + s.acres; }, 0);
        if (!slices.length || !(total > 0)) {
            host.innerHTML = '<div class="chart-empty">No areas</div>';
            return;
        }

        var svgNS = 'http://www.w3.org/2000/svg';
        var size = 210;
        var cx = 105;
        var cy = 105;
        var radius = 62;
        var circ = 2 * Math.PI * radius;
        var svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
        var drawn = 0;
        slices.forEach(function (slice, index) {
            var len = index === slices.length - 1 ? Math.max(0, circ - drawn) : (slice.acres / total) * circ;
            var ring = document.createElementNS(svgNS, 'circle');
            ring.setAttribute('cx', cx);
            ring.setAttribute('cy', cy);
            ring.setAttribute('r', radius);
            ring.setAttribute('fill', 'none');
            ring.setAttribute('stroke', slice.color);
            ring.setAttribute('stroke-width', '26');
            ring.setAttribute('stroke-dasharray', len + ' ' + Math.max(0, circ - len));
            ring.setAttribute('stroke-dashoffset', String(-drawn));
            ring.setAttribute('transform', 'rotate(-90 ' + cx + ' ' + cy + ')');
            svg.appendChild(ring);

            var mid = -Math.PI / 2 + ((drawn + len / 2) / circ) * Math.PI * 2;
            var lx = cx + Math.cos(mid) * 92;
            var ly = cy + Math.sin(mid) * 92;
            if (len / circ >= 0.06) {
                var label = document.createElementNS(svgNS, 'text');
                label.setAttribute('x', lx);
                label.setAttribute('y', ly);
                label.setAttribute('text-anchor', lx > cx + 8 ? 'start' : (lx < cx - 8 ? 'end' : 'middle'));
                label.setAttribute('dominant-baseline', 'middle');
                label.setAttribute('fill', '#1f2933');
                label.setAttribute('font-size', '11');
                label.setAttribute('font-weight', '700');
                label.setAttribute('font-family', 'Segoe UI, Tahoma, Arial, sans-serif');
                label.textContent = fmtAcres(slice.acres);
                svg.appendChild(label);
            }
            drawn += len;
        });
        host.appendChild(svg);

        var center = document.createElement('div');
        center.className = 'donut-center';
        center.innerHTML = '<strong>' + fmtAcres(total) + '</strong><span>ac</span>';
        host.appendChild(center);

        slices.forEach(function (slice) {
            var row = document.createElement('div');
            row.className = 'chart-row';
            row.innerHTML = '<span class="chart-dot" style="background:' + slice.color + '"></span>' +
                '<span>' + slice.zone + ' ' + slice.label +
                    (slice.value == null ? '' : '<span class="chart-agg">' + ($('zoneAgg').value === 'median' ? 'Median' : 'Average') + ' ' + fmt(slice.value) + '</span>') +
                '</span>' +
                '<span class="chart-acres">' + fmtAcres(slice.acres) + ' ac</span>';
            list.appendChild(row);
        });
    }

    function fmt(v) {
        var n = Number(v);
        if (Math.abs(n * 10 - Math.round(n * 10)) < 1e-6) return n.toFixed(1);
        return n.toFixed(2);
    }

    function updateLegend(breaks) {
        var n = breaks.length + 1;
        var bar = $('legendBar');
        var ticks = $('legendTicks');
        var rows = $('legendRows');
        bar.style.gridTemplateColumns = 'repeat(' + n + ', 1fr)';
        bar.innerHTML = '';
        rows.innerHTML = '';
        for (var z = 1; z <= n; z++) {
            var color = zoneStyle(z, n);
            var name = zoneName(z, n);
            var range = classRange(z, breaks, classBounds($('zoneMethod').value));
            var seg = document.createElement('div');
            seg.className = 'legend-seg';
            seg.style.background = color.hex;
            seg.style.color = (color.r + color.g + color.b) > 520 ? '#3f3f3f' : '#fff';
            seg.textContent = name;
            bar.appendChild(seg);
            var row = document.createElement('div');
            row.className = 'legend-row';
            row.innerHTML = '<span class="swatch" style="background:' + color.hex + '"></span>' +
                '<span>' + name + '</span>' +
                '<span class="legend-range">' + fmt(range.min) + ' to ' + fmt(range.max) + '</span>';
            rows.appendChild(row);
        }
        var bounds = classBounds($('zoneMethod').value);
        var marks = [bounds.min].concat(breaks).concat([bounds.max]);
        ticks.innerHTML = marks.map(function (v) {
            return '<span>' + fmt(v) + '</span>';
        }).join('');
        $('legendTitle').textContent = methodLabel($('zoneMethod').value);
    }

    async function generateZones() {
        if (!state.ndvi) return;
        setMessage('Building zones');
        await new Promise(function (r) { setTimeout(r, 20); });
        try {
            var n = zoneCount();
            var method = $('zoneMethod').value || 'natural';
            var breaks = chooseBreaks(method, n);
            if (!breaks.length) throw new Error('Could not split the index into zones.');
            var classCount = breaks.length + 1;
            var grid = classifyRaster(breaks);
            var minAcres = Number($('minAcres').value);
            if (!isFinite(minAcres) || minAcres < 0) minAcres = 0;
            sieveSmallComponents(grid, minAcres);
            var aggValues = zoneAggregate(grid, $('zoneAgg').value);
            var features = polygonizeZones(grid, breaks, method, aggValues);
            if (!features.length) throw new Error('No polygons. Lower the minimum polygon size.');
            showClassOverlay(grid, classCount);
            renderZones(features);
            updateLegend(breaks);
            setMessage('');
        } catch (err) {
            console.error(err);
            setMessage(err.message || 'Failed to build zones');
        }
    }

    function exportGeoJSON() {
        var fc = {
            type: 'FeatureCollection',
            name: 'ndvi_vigor_zones',
            features: state.features.map(function (f, i) {
                return {
                    type: 'Feature',
                    properties: {
                        id: i + 1,
                        zone: f.properties.zone,
                        label: f.properties.label,
                        ndvi_min: f.properties.ndvi_min,
                        ndvi_max: f.properties.ndvi_max,
                        ndvi_value: f.properties.ndvi_value,
                        area_acres: f.properties.area_acres
                    },
                    geometry: f.geometry
                };
            })
        };
        var blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'ndvi_vigor_zones.geojson';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    }

    async function loadBuffer(buffer, name) {
        setMessage('Loading index');
        try {
            await parseGeoTIFF(buffer, name);
        } catch (err) {
            console.error(err);
            setMessage(err.message || 'Could not read GeoTIFF');
        }
    }

    function closePickers() {
        var open = document.querySelectorAll('.picker.is-open');
        for (var i = 0; i < open.length; i++) {
            open[i].classList.remove('is-open');
            var menu = open[i].querySelector('.picker-menu');
            if (menu) menu.hidden = true;
        }
    }

    function enhanceSelect(select) {
        var picker = document.createElement('div');
        picker.className = 'picker';
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'picker-btn';
        button.setAttribute('aria-haspopup', 'listbox');
        var menu = document.createElement('div');
        menu.className = 'picker-menu';
        menu.hidden = true;
        menu.setAttribute('role', 'listbox');

        function paint() {
            var current = select.options[select.selectedIndex];
            button.textContent = current ? current.textContent : '';
            var items = menu.querySelectorAll('.picker-item');
            for (var i = 0; i < items.length; i++) {
                items[i].classList.toggle('is-selected', items[i].dataset.value === select.value);
            }
        }

        for (var i = 0; i < select.options.length; i++) {
            (function (opt) {
                var item = document.createElement('button');
                item.type = 'button';
                item.className = 'picker-item';
                item.dataset.value = opt.value;
                item.textContent = '';
                var value = document.createElement('span');
                value.textContent = opt.textContent;
                item.appendChild(value);
                var hint = opt.getAttribute('data-hint');
                if (hint) {
                    var note = document.createElement('span');
                    note.className = 'picker-hint';
                    note.textContent = hint;
                    item.appendChild(note);
                }
                item.setAttribute('role', 'option');
                item.addEventListener('click', function (e) {
                    e.stopPropagation();
                    select.value = opt.value;
                    paint();
                    closePickers();
                    select.dispatchEvent(new Event('change'));
                });
                menu.appendChild(item);
            })(select.options[i]);
        }

        button.addEventListener('click', function (e) {
            e.stopPropagation();
            var willOpen = menu.hidden;
            closePickers();
            if (willOpen) {
                menu.hidden = false;
                picker.classList.add('is-open');
            }
        });

        select.classList.add('picker-native');
        select.parentNode.insertBefore(picker, select);
        picker.appendChild(button);
        picker.appendChild(menu);
        picker.appendChild(select);
        paint();
    }

    function bindUi() {
        enhanceSelect($('zoneCount'));
        enhanceSelect($('zoneMethod'));
        enhanceSelect($('zoneAgg'));
        enhanceSelect($('minAcres'));
        document.addEventListener('click', closePickers);
        $('tifInput').addEventListener('change', function (e) {
            var file = e.target.files && e.target.files[0];
            if (!file) return;
            file.arrayBuffer().then(function (buf) { loadBuffer(buf, file.name); });
        });
        $('minAcres').addEventListener('change', scheduleZones);
        $('zoneCount').addEventListener('change', scheduleZones);
        $('zoneMethod').addEventListener('change', scheduleZones);
        $('zoneAgg').addEventListener('change', scheduleZones);
        $('layerImage').addEventListener('change', applyLayers);
        $('layerPolygons').addEventListener('change', applyLayers);
        $('exportGeojsonBtn').addEventListener('click', exportGeoJSON);
        updateFieldNotes();
    }

    function updateFieldNotes() {
        $('zoneNote').textContent = optionHint($('zoneCount'));
        $('methodNote').textContent = optionHint($('zoneMethod'));
        $('aggNote').textContent = optionHint($('zoneAgg'));
        $('acreNote').textContent = optionHint($('minAcres'));
    }

    function optionHint(select) {
        var opt = select.options[select.selectedIndex];
        return opt ? (opt.getAttribute('data-hint') || '') : '';
    }

    function scheduleZones() {
        clearTimeout(state.regenTimer);
        updateFieldNotes();
        generateZones();
    }

    document.addEventListener('DOMContentLoaded', function () {
        initMap();
        bindUi();
        fetch(DEFAULT_TIF).then(function (res) {
            if (!res.ok) throw new Error('not found');
            return res.arrayBuffer();
        }).then(function (buf) {
            return loadBuffer(buf, 'NDVI.tif');
        }).catch(function () {
            return fetch('NDVI.tif').then(function (res) {
                if (!res.ok) throw new Error('not found');
                return res.arrayBuffer();
            }).then(function (buf) {
                return loadBuffer(buf, 'NDVI.tif');
            });
        }).catch(function () {
            setMessage('Open a GeoTIFF to begin');
        });
    });
})();
