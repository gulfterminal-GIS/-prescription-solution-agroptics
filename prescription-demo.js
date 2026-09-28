/**
 * Agroptics Prescription Demo — v3.0
 * Loads a single-band index GeoTIFF and splits it into prescription zones.
 * Supports: prescription types, editable rates, smoothing, multiple exports.
 */
(function () {
    'use strict';

    /* ═══════════ CONSTANTS ══════════════════════════════════════ */
    var DEFAULT_TIF = 'https://satalite-images-04-2026.s3.eu-north-1.amazonaws.com/Individual/amhashem85-gmail.com/Dina_Farms/Takwa_1_correct/851e9092-44e4-49c8-9e89-d6974b9bf03c/processed/2026-06-26_084002/NDVI.tif';
    var ACRES_PER_M2 = 0.000247105;
    var HA_PER_M2 = 0.0001;
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

    /* Prescription type configuration */
    var RX_UNITS = {
        irrigation: [
            { value: 'inch', label: 'inch' },
            { value: 'mm', label: 'mm' }
        ],
        seeding: [
            { value: 'seeds/ac', label: 'seeds/ac' }
        ],
        fertilizer: [
            { value: 'lb/ac', label: 'lb/ac (solid)' },
            { value: 'kg/ha', label: 'kg/ha (solid)' },
            { value: 'gal/ac', label: 'gal/ac (liquid)' },
            { value: 'L/ha', label: 'L/ha (liquid)' }
        ],
        herbicide: [
            { value: 'lb/ac', label: 'lb/ac (solid)' },
            { value: 'kg/ha', label: 'kg/ha (solid)' },
            { value: 'gal/ac', label: 'gal/ac (liquid)' },
            { value: 'L/ha', label: 'L/ha (liquid)' }
        ]
    };

    var RX_DEFAULT_RATES = {
        irrigation: [0, 0.5, 0.8, 1.0, 1.2],
        seeding: [0, 28000, 32000, 34000, 36000],
        fertilizer: [0, 80, 120, 160, 200],
        herbicide: [0, 12, 16, 20, 24]
    };

    /* ═══════════ STATE ══════════════════════════════════════════ */
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
        regenTimer: null,
        classifiedGrid: null,
        currentBreaks: null,
        rxType: 'irrigation',
        rxUnit: 'inch',
        zoneRates: {}
    };

    /* ═══════════ HELPERS ════════════════════════════════════════ */
    function $(id) { return document.getElementById(id); }

    function setMessage(text) {
        var el = $('mapMessage');
        if (!text) { el.classList.add('hidden'); return; }
        el.textContent = text;
        el.classList.remove('hidden');
    }

    function fmt(v) {
        var n = Number(v);
        if (Math.abs(n * 10 - Math.round(n * 10)) < 1e-6) return n.toFixed(1);
        return n.toFixed(2);
    }

    function fmtAcres(v) {
        if (v >= 100) return String(Math.round(v));
        if (v >= 10) return v.toFixed(1);
        return v.toFixed(2);
    }

    /* ═══════════ MAP INIT ═══════════════════════════════════════ */
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

    /* ═══════════ PROJECTION ═════════════════════════════════════ */
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

    /* ═══════════ COLOR ══════════════════════════════════════════ */
    function rdylgnColor(t) {
        t = Math.max(0, Math.min(1, t));
        var index = t * (RDYLGN.length - 1);
        var i = Math.floor(index);
        var f = index - i;
        if (i >= RDYLGN.length - 1) return { r: RDYLGN[6][0], g: RDYLGN[6][1], b: RDYLGN[6][2] };
        var c1 = RDYLGN[i], c2 = RDYLGN[i + 1];
        return {
            r: Math.round(c1[0] + f * (c2[0] - c1[0])),
            g: Math.round(c1[1] + f * (c2[1] - c1[1])),
            b: Math.round(c1[2] + f * (c2[2] - c1[2]))
        };
    }

    function zoneStyle(z, n) {
        if (n === 3) return CLASS_COLORS[z];
        var t = n <= 1 ? 1 : (z - 1) / (n - 1);
        var c = rdylgnColor(t);
        var hex = '#' + [c.r, c.g, c.b].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
        return { r: c.r, g: c.g, b: c.b, hex: hex };
    }

    function zoneName(z, n) {
        if (n === 3) return CLASS_NAMES[z];
        if (n === 2) return z === 1 ? 'Low' : 'High';
        return 'Zone ' + z;
    }

    /* ═══════════ GEOTIFF PARSING ════════════════════════════════ */
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
            if (!isFinite(v)) { valuesGrid[i] = NaN; continue; }
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

    /* ═══════════ CLASSIFICATION ═════════════════════════════════ */
    function zoneCount() {
        var n = Number($('zoneCount').value);
        if (n !== 2 && n !== 3 && n !== 4 && n !== 5) n = 3;
        return n;
    }

    function getCustomBreaks(n) {
        var inputs = document.querySelectorAll('#breakEditor input');
        var breaks = [];
        for (var i = 0; i < inputs.length; i++) {
            var v = parseFloat(inputs[i].value);
            if (isFinite(v)) breaks.push(v);
        }
        breaks.sort(function (a, b) { return a - b; });
        return breaks;
    }

    function tableBreaks(n) {
        var custom = getCustomBreaks(n);
        if (custom.length === n - 1) return custom;
        /* Fallback defaults */
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
        var lowerClassLimits = [], varianceCombinations = [];
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
        if (method === 'equal') return 'Equal Interval';
        if (method === 'table') return 'Reclassify by Table';
        return 'Natural Breaks';
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

    /* ═══════════ SIEVE ══════════════════════════════════════════ */
    function sieveSmallComponents(grid, minAcres) {
        if (!(minAcres > 0)) return grid;
        var w = state.width, h = state.height;
        var minPixels = Math.max(1, Math.round(minAcres / pixelAreaAcres()));
        for (var pass = 0; pass < 8; pass++) {
            var labels = new Int32Array(w * h);
            var sizes = [0], clsOf = [0];
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
                    if (votes[k] > bestN) { bestN = votes[k]; best = Number(k); }
                });
                if (!best) return;
                for (var q = 0; q < w * h; q++) {
                    if (labels[q] === lab) grid[q] = best;
                }
            });
        }
        return grid;
    }

    /* ═══════════ VECTORIZE ══════════════════════════════════════ */
    function collectRings(grid, cls) {
        var w = state.width, h = state.height;
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

    /* ═══════════ SMOOTHING ══════════════════════════════════════ */
    function smoothRing(ring, iterations) {
        if (!iterations || ring.length < 4) return ring;
        var result = ring;
        for (var iter = 0; iter < iterations; iter++) {
            var newRing = [result[0]];
            for (var i = 0; i < result.length - 1; i++) {
                var p0 = result[i];
                var p1 = result[(i + 1) % (result.length - 1)] || result[i + 1];
                newRing.push([
                    0.75 * p0[0] + 0.25 * p1[0],
                    0.75 * p0[1] + 0.25 * p1[1]
                ]);
                newRing.push([
                    0.25 * p0[0] + 0.75 * p1[0],
                    0.25 * p0[1] + 0.75 * p1[1]
                ]);
            }
            newRing.push(newRing[0].slice());
            result = newRing;
        }
        return result;
    }

    function smoothPolygonCoords(coords, iterations) {
        return coords.map(function (ring) {
            return smoothRing(ring, iterations);
        });
    }

    /* ═══════════ ZONE BUILDING ══════════════════════════════════ */
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
        var doSmooth = $('smoothToggle') && $('smoothToggle').checked;
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
                /* Apply smoothing if enabled */
                var finalCoords = doSmooth ? smoothPolygonCoords(coords, 2) : coords;
                var geom = { type: 'Polygon', coordinates: finalCoords };
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
                        area_ha: Number((areaM2 * HA_PER_M2).toFixed(4)),
                        color: color.hex,
                        rx_type: state.rxType,
                        rx_unit: state.rxUnit,
                        rate: state.zoneRates[z] || 0
                    },
                    geometry: geom
                });
            });
        }
        return features;
    }

    /* ═══════════ RENDER CLASSIFIED IMAGE ════════════════════════ */
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
            if (!cls || !colors[cls]) { img.data[o + 3] = 0; continue; }
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

    /* ═══════════ RENDER ZONE POLYGONS ═══════════════════════════ */
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
        $('exportBtn').disabled = features.length === 0;
        applyLayers();
        updateZoneCombinedList(features);
        updateTotals(features);
    }

    function applyLayers() {
        toggleMapLayer(state.ndviLayer, $('layerImage') && $('layerImage').checked);
        toggleMapLayer(state.zoneLayer, $('layerPolygons') && $('layerPolygons').checked);
        if (state.zoneLayer && state.map.hasLayer(state.zoneLayer)) state.zoneLayer.bringToFront();
    }

    function toggleMapLayer(layer, on) {
        if (!layer || !state.map) return;
        if (on) { if (!state.map.hasLayer(layer)) layer.addTo(state.map); }
        else if (state.map.hasLayer(layer)) { state.map.removeLayer(layer); }
    }

    /* ═══════════ LEGEND (in-panel colour bar) ══════════════════ */
    function updateLegend(breaks) {
        var n = breaks.length + 1;
        var bar = $('legendBar');
        var ticks = $('legendTicks');
        if (!bar || !ticks) return;
        bar.style.gridTemplateColumns = 'repeat(' + n + ', 1fr)';
        bar.innerHTML = '';
        for (var z = 1; z <= n; z++) {
            var color = zoneStyle(z, n);
            var name = zoneName(z, n);
            var seg = document.createElement('div');
            seg.className = 'legend-seg';
            seg.style.background = color.hex;
            seg.style.color = (color.r + color.g + color.b) > 520 ? '#3f3f3f' : '#fff';
            seg.textContent = name;
            bar.appendChild(seg);
        }
        var bounds = classBounds($('zoneMethod').value);
        var marks = [bounds.min].concat(breaks).concat([bounds.max]);
        ticks.innerHTML = marks.map(function (v) { return '<span>' + fmt(v) + '</span>'; }).join('');
    }

    /* ═══════════ DONUT CHART ════════════════════════════════════ */
    function buildDonut(slices, total) {
        var host = $('zoneChart');
        host.innerHTML = '';
        if (!slices.length || !(total > 0)) {
            host.innerHTML = '<div class="chart-empty">No areas</div>';
            return;
        }
        var svgNS = 'http://www.w3.org/2000/svg';
        var size = 200, cx = 100, cy = 100, radius = 58;
        var circ = 2 * Math.PI * radius;
        var svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
        var drawn = 0;
        slices.forEach(function (slice, index) {
            var len = index === slices.length - 1 ? Math.max(0, circ - drawn) : (slice.acres / total) * circ;
            var ring = document.createElementNS(svgNS, 'circle');
            ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', radius);
            ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', slice.color);
            ring.setAttribute('stroke-width', '24');
            ring.setAttribute('stroke-dasharray', len + ' ' + Math.max(0, circ - len));
            ring.setAttribute('stroke-dashoffset', String(-drawn));
            ring.setAttribute('transform', 'rotate(-90 ' + cx + ' ' + cy + ')');
            svg.appendChild(ring);
            var mid = -Math.PI / 2 + ((drawn + len / 2) / circ) * Math.PI * 2;
            var lx = cx + Math.cos(mid) * 86, ly = cy + Math.sin(mid) * 86;
            if (len / circ >= 0.06) {
                var lbl = document.createElementNS(svgNS, 'text');
                lbl.setAttribute('x', lx); lbl.setAttribute('y', ly);
                lbl.setAttribute('text-anchor', lx > cx + 8 ? 'start' : (lx < cx - 8 ? 'end' : 'middle'));
                lbl.setAttribute('dominant-baseline', 'middle');
                lbl.setAttribute('fill', '#1f2933'); lbl.setAttribute('font-size', '11');
                lbl.setAttribute('font-weight', '700'); lbl.setAttribute('font-family', 'Inter, sans-serif');
                lbl.textContent = fmtAcres(slice.acres);
                svg.appendChild(lbl);
            }
            drawn += len;
        });
        host.appendChild(svg);
        var center = document.createElement('div');
        center.className = 'donut-center';
        center.innerHTML = '<strong>' + fmtAcres(total) + '</strong><span>ac</span>';
        host.appendChild(center);
    }

    /* ═══════════ COMBINED ZONE LIST (chart + legend info + rates) */
    function updateZoneCombinedList(features) {
        /* Build per-zone aggregates */
        var groups = {};
        features.forEach(function (f) {
            var z = f.properties.zone;
            if (!groups[z]) {
                groups[z] = {
                    zone: z, label: f.properties.label, color: f.properties.color,
                    acres: 0, value: f.properties.ndvi_value,
                    ndvi_min: f.properties.ndvi_min, ndvi_max: f.properties.ndvi_max
                };
            }
            groups[z].acres += Number(f.properties.area_acres) || 0;
        });
        var slices = Object.keys(groups).map(function (k) { return groups[k]; });
        slices.sort(function (a, b) { return a.zone - b.zone; });
        var total = slices.reduce(function (s, sl) { return s + sl.acres; }, 0);

        /* Donut */
        buildDonut(slices, total);

        /* Zone cards */
        var container = $('zoneCombinedList');
        if (!container) return;
        container.innerHTML = '';
        var defaults = RX_DEFAULT_RATES[state.rxType] || [0, 0, 0, 0, 0];
        var aggLabel = $('zoneAgg').value === 'median' ? 'Median' : 'Average';

        slices.forEach(function (sl) {
            if (state.zoneRates[sl.zone] == null) {
                state.zoneRates[sl.zone] = defaults[sl.zone] || 0;
            }
            var card = document.createElement('div');
            card.className = 'zone-combined-row';

            var metaHtml = sl.value != null
                ? aggLabel + ' index: ' + fmt(sl.value)
                : '';
            var rangeHtml = 'Range: ' + fmt(sl.ndvi_min) + ' – ' + fmt(sl.ndvi_max);

            card.innerHTML =
                '<div class="zcr-header">' +
                    '<span class="zcr-dot" style="background:' + sl.color + '"></span>' +
                    '<span class="zcr-name">' + sl.zone + '. ' + sl.label + '</span>' +
                    '<span class="zcr-area">' + fmtAcres(sl.acres) + ' ac</span>' +
                '</div>' +
                (metaHtml ? '<div class="zcr-meta">' + metaHtml + '</div>' : '') +
                '<div class="zcr-range">' + rangeHtml + '</div>' +
                '<div class="zcr-rate-row">' +
                    '<span class="zcr-rate-label">Rate:</span>' +
                    '<input class="zcr-rate-input" type="number" min="0" step="any" value="' +
                        (state.zoneRates[sl.zone] != null ? state.zoneRates[sl.zone] : '') + '" />' +
                    '<span class="zcr-rate-unit">' + state.rxUnit + '</span>' +
                '</div>';

            container.appendChild(card);

            /* Rate change handler — closure over sl.zone */
            (function (zoneId) {
                card.querySelector('.zcr-rate-input').addEventListener('input', function (e) {
                    state.zoneRates[zoneId] = parseFloat(e.target.value) || 0;
                    state.features.forEach(function (f) {
                        if (f.properties.zone === zoneId) f.properties.rate = state.zoneRates[zoneId];
                    });
                    updateTotals(state.features);
                });
            })(sl.zone);
        });
    }

    /* ═══════════ TOTALS ═════════════════════════════════════════ */
    function updateTotals(features) {
        var grid = $('totalsGrid');
        grid.innerHTML = '';
        var totalArea = 0, totalProduct = 0;
        var groups = {};
        features.forEach(function (f) {
            var z = f.properties.zone;
            var ac = Number(f.properties.area_acres) || 0;
            totalArea += ac;
            if (!groups[z]) groups[z] = { acres: 0, rate: state.zoneRates[z] || 0 };
            groups[z].acres += ac;
        });
        Object.keys(groups).forEach(function (z) {
            totalProduct += groups[z].acres * groups[z].rate;
        });

        var rows = [
            { label: 'Total area', value: fmtAcres(totalArea) + ' ac' },
            { label: 'Total product', value: totalProduct.toFixed(1) + ' ' + state.rxUnit }
        ];
        rows.forEach(function (r) {
            var row = document.createElement('div');
            row.className = 'total-row';
            row.innerHTML = '<span class="total-label">' + r.label + '</span><span class="total-value">' + r.value + '</span>';
            grid.appendChild(row);
        });
    }

    /* ═══════════ ZONE GENERATION ════════════════════════════════ */
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
            state.classifiedGrid = grid;
            state.currentBreaks = breaks;
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

    /* ═══════════ EXPORT — GeoJSON ═══════════════════════════════ */
    function exportGeoJSON() {
        var fc = {
            type: 'FeatureCollection',
            name: state.rxType + '_prescription_zones',
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
                        area_acres: f.properties.area_acres,
                        area_ha: f.properties.area_ha,
                        rx_type: state.rxType,
                        rate: state.zoneRates[f.properties.zone] || 0,
                        unit: state.rxUnit
                    },
                    geometry: f.geometry
                };
            })
        };
        var blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        downloadBlob(blob, state.rxType + '_prescription.geojson');
    }

    /* ═══════════ EXPORT — Shapefile (.zip) ═════════════════════ */

    /* ── Low-level binary helpers ──────────────────────────────── */
    function writeInt32BE(view, offset, val) {
        view.setInt32(offset, val, false); /* big-endian */
    }
    function writeInt32LE(view, offset, val) {
        view.setInt32(offset, val, true); /* little-endian */
    }
    function writeFloat64LE(view, offset, val) {
        view.setFloat64(offset, val, true);
    }

    /* Build .prj (WGS 84 geographic) */
    function buildPrj() {
        return 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    }

    /* Build .dbf — dBASE III+ */
    function buildDbf(records, fieldDefs) {
        /* fieldDefs: [{name, type:'N'|'C', length, decimals}] */
        var nRecs = records.length;
        var nFields = fieldDefs.length;
        var recLen = 1; /* deletion flag */
        fieldDefs.forEach(function (f) { recLen += f.length; });
        var headerSize = 32 + nFields * 32 + 1;
        var totalSize = headerSize + nRecs * recLen;
        var buf = new ArrayBuffer(totalSize);
        var view = new DataView(buf);
        var u8 = new Uint8Array(buf);
        /* Version */
        u8[0] = 3;
        /* Date */
        var d = new Date();
        u8[1] = d.getFullYear() - 1900; u8[2] = d.getMonth() + 1; u8[3] = d.getDate();
        /* Num records */
        view.setUint32(4, nRecs, true);
        /* Header size */
        view.setUint16(8, headerSize, true);
        /* Record size */
        view.setUint16(10, recLen, true);
        /* Field descriptors at offset 32 */
        var enc = new TextEncoder();
        fieldDefs.forEach(function (fd, fi) {
            var base = 32 + fi * 32;
            var nameBytes = enc.encode(fd.name.substring(0, 10));
            for (var i = 0; i < nameBytes.length; i++) u8[base + i] = nameBytes[i];
            u8[base + 11] = fd.type.charCodeAt(0);
            u8[base + 16] = fd.length;
            u8[base + 17] = fd.decimals || 0;
        });
        /* Header terminator */
        u8[32 + nFields * 32] = 0x0D;
        /* Records */
        records.forEach(function (rec, ri) {
            var rBase = headerSize + ri * recLen;
            u8[rBase] = 0x20; /* not deleted */
            var fOffset = rBase + 1;
            fieldDefs.forEach(function (fd) {
                var raw = String(rec[fd.name] == null ? '' : rec[fd.name]);
                var padded = raw.substring(0, fd.length).padStart(fd.length, ' ');
                var bytes = enc.encode(padded).subarray(0, fd.length);
                for (var i = 0; i < fd.length; i++) u8[fOffset + i] = (bytes[i] || 0x20);
                fOffset += fd.length;
            });
        });
        return buf;
    }

    /* Build .shp + .shx for polygon features (ESRI Shapefile type 5) */
    function buildShpShx(features) {
        /* Pre-compute record byte sizes */
        var recordInfos = features.map(function (feat) {
            var coords = feat.geometry.coordinates;
            /* Flatten all rings to count total points */
            var numParts = coords.length;
            var numPoints = coords.reduce(function (s, ring) { return s + ring.length; }, 0);
            var contentLen = (44 + numParts * 4 + numPoints * 16) / 2; /* in 16-bit words */
            return { numParts: numParts, numPoints: numPoints, contentLen: contentLen, coords: coords };
        });

        /* Global bounding box */
        var gXmin = Infinity, gYmin = Infinity, gXmax = -Infinity, gYmax = -Infinity;
        features.forEach(function (f) {
            f.geometry.coordinates.forEach(function (ring) {
                ring.forEach(function (pt) {
                    if (pt[0] < gXmin) gXmin = pt[0]; if (pt[0] > gXmax) gXmax = pt[0];
                    if (pt[1] < gYmin) gYmin = pt[1]; if (pt[1] > gYmax) gYmax = pt[1];
                });
            });
        });
        if (!isFinite(gXmin)) { gXmin = gYmin = gXmax = gYmax = 0; }

        /* .shx is fixed at 100 + 8*numRecords bytes */
        var shxSize = 100 + 8 * features.length;
        /* .shp size: 100 header + sum of (8 + contentLen*2) per record */
        var shpSize = 100;
        recordInfos.forEach(function (r) { shpSize += 8 + r.contentLen * 2; });

        var shpBuf = new ArrayBuffer(shpSize);
        var shxBuf = new ArrayBuffer(shxSize);
        var shpV = new DataView(shpBuf);
        var shxV = new DataView(shxBuf);

        /* Write file header helper */
        function writeFileHeader(view, fileCode, fileLen) {
            writeInt32BE(view, 0, 9994);       /* file code */
            writeInt32BE(view, 24, fileLen);   /* file length in 16-bit words */
            writeInt32LE(view, 28, 1000);      /* version */
            writeInt32LE(view, 32, 5);         /* shape type: polygon */
            writeFloat64LE(view, 36, gXmin);   writeFloat64LE(view, 44, gYmin);
            writeFloat64LE(view, 52, gXmax);   writeFloat64LE(view, 60, gYmax);
            /* Z and M bounding box zeros */
            for (var i = 68; i < 100; i += 8) writeFloat64LE(view, i, 0);
        }
        writeFileHeader(shpV, 9994, shpSize / 2);
        writeFileHeader(shxV, 9994, shxSize / 2);

        var shpOff = 100, shxOff = 100;

        recordInfos.forEach(function (ri, idx) {
            var coords = ri.coords;
            var feat = features[idx];

            /* Local bbox */
            var xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            coords.forEach(function (ring) {
                ring.forEach(function (pt) {
                    if (pt[0] < xmin) xmin = pt[0]; if (pt[0] > xmax) xmax = pt[0];
                    if (pt[1] < ymin) ymin = pt[1]; if (pt[1] > ymax) ymax = pt[1];
                });
            });

            /* SHX entry */
            writeInt32BE(shxV, shxOff, shpOff / 2);
            writeInt32BE(shxV, shxOff + 4, ri.contentLen);
            shxOff += 8;

            /* SHP record header */
            writeInt32BE(shpV, shpOff, idx + 1);          /* record number (1-based) */
            writeInt32BE(shpV, shpOff + 4, ri.contentLen); /* content length */
            shpOff += 8;

            /* SHP record content */
            writeInt32LE(shpV, shpOff, 5);                /* shape type polygon */
            writeFloat64LE(shpV, shpOff + 4, xmin);
            writeFloat64LE(shpV, shpOff + 12, ymin);
            writeFloat64LE(shpV, shpOff + 20, xmax);
            writeFloat64LE(shpV, shpOff + 28, ymax);
            writeInt32LE(shpV, shpOff + 36, ri.numParts);
            writeInt32LE(shpV, shpOff + 40, ri.numPoints);
            var partOff = shpOff + 44;
            var ptOff = partOff + ri.numParts * 4;
            var pointIdx = 0;
            coords.forEach(function (ring, rIdx) {
                writeInt32LE(shpV, partOff + rIdx * 4, pointIdx);
                ring.forEach(function (pt) {
                    writeFloat64LE(shpV, ptOff + pointIdx * 16, pt[0]);
                    writeFloat64LE(shpV, ptOff + pointIdx * 16 + 8, pt[1]);
                    pointIdx++;
                });
            });
            shpOff += ri.contentLen * 2;   /* header (8) already consumed above */
        });

        return { shp: shpBuf, shx: shxBuf };
    }

    /* Main shapefile export */
    async function exportShapefile() {
        if (!state.features.length) return;

        /* Build DBF field definitions (max 10-char names) */
        var fieldDefs = [
            { name: 'FID',     type: 'N', length: 6,  decimals: 0 },
            { name: 'Zone',    type: 'N', length: 4,  decimals: 0 },
            { name: 'Label',   type: 'C', length: 20, decimals: 0 },
            { name: 'Rate',    type: 'N', length: 12, decimals: 4 },
            { name: 'Unit',    type: 'C', length: 16, decimals: 0 },
            { name: 'Area_ac', type: 'N', length: 12, decimals: 4 },
            { name: 'Area_ha', type: 'N', length: 12, decimals: 4 },
            { name: 'Idx_min', type: 'N', length: 12, decimals: 4 },
            { name: 'Idx_max', type: 'N', length: 12, decimals: 4 },
            { name: 'Rx_type', type: 'C', length: 20, decimals: 0 }
        ];

        /* Merge multi-polygon features by zone for cleaner shapefile */
        var groups = {};
        state.features.forEach(function (f) {
            var z = f.properties.zone;
            if (!groups[z]) {
                groups[z] = { props: f.properties, polys: [] };
            }
            groups[z].polys.push(f);
        });

        /* Flatten — one record per polygon feature */
        var outFeatures = [];
        var dbfRecords = [];
        var fid = 1;
        Object.keys(groups).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (z) {
            var g = groups[z];
            g.polys.forEach(function (f) {
                outFeatures.push(f);
                dbfRecords.push({
                    FID:     fid++,
                    Zone:    f.properties.zone,
                    Label:   f.properties.label,
                    Rate:    state.zoneRates[f.properties.zone] || 0,
                    Unit:    state.rxUnit,
                    Area_ac: f.properties.area_acres,
                    Area_ha: f.properties.area_ha,
                    Idx_min: f.properties.ndvi_min,
                    Idx_max: f.properties.ndvi_max,
                    Rx_type: state.rxType
                });
            });
        });

        var shpShx = buildShpShx(outFeatures);
        var dbfBuf = buildDbf(dbfRecords, fieldDefs);
        var prjStr = buildPrj();

        var zip = new JSZip();
        var baseName = state.rxType + '_VRA';
        zip.file(baseName + '.shp', shpShx.shp);
        zip.file(baseName + '.shx', shpShx.shx);
        zip.file(baseName + '.dbf', dbfBuf);
        zip.file(baseName + '.prj', prjStr);
        /* Also bundle a GeoJSON for convenience */
        var geojsonStr = JSON.stringify({
            type: 'FeatureCollection',
            features: outFeatures.map(function (f, i) {
                return { type: 'Feature', properties: dbfRecords[i], geometry: f.geometry };
            })
        }, null, 2);
        zip.file(baseName + '.geojson', geojsonStr);

        var zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        downloadBlob(zipBlob, baseName + '.zip');
    }

    /* ═══════════ EXPORT — PDF Report ════════════════════════════ */

    /* Build classified raster canvas data-URL */
    function buildClassifiedDataURL() {
        if (!state.classifiedGrid || !state.ndvi) return null;
        var n = state.currentBreaks ? state.currentBreaks.length + 1 : 3;
        var canvas = document.createElement('canvas');
        canvas.width = state.width;
        canvas.height = state.height;
        var ctx = canvas.getContext('2d');
        var img = ctx.createImageData(state.width, state.height);
        var colors = [];
        for (var z = 1; z <= n; z++) colors[z] = zoneStyle(z, n);
        for (var i = 0; i < state.classifiedGrid.length; i++) {
            var o = i * 4;
            var cls = state.classifiedGrid[i];
            if (!cls || !colors[cls]) { img.data[o + 3] = 0; continue; }
            img.data[o] = colors[cls].r;
            img.data[o + 1] = colors[cls].g;
            img.data[o + 2] = colors[cls].b;
            img.data[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return canvas.toDataURL('image/png');
    }

    /* Polygon-only image — white background, fills + outlines ("Classified OFF, Polygons ON" view) */
    function buildPolygonDataURL() {
        if (!state.features.length || !state.classifiedGrid) return null;
        var w = state.width, h = state.height;
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');

        /* White background — matches having the classified layer turned OFF */
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);

        /* Helper: lng/lat → pixel */
        function toPixel(lng, lat) {
            var x, y;
            if (Math.abs(state.bbox[0]) > 180) {
                defineUtm(state.sourceProj);
                var m = proj4('EPSG:4326', state.sourceProj, [lng, lat]);
                x = (m[0] - state.bbox[0]) / state.pixelWidth;
                y = (state.bbox[3] - m[1]) / state.pixelHeight;
            } else {
                x = (lng - state.bbox[0]) / state.pixelWidth;
                y = (state.bbox[3] - lat) / state.pixelHeight;
            }
            return [x, y];
        }

        /* Group all rings per zone */
        var zoneGroups = {};
        state.features.forEach(function (feat) {
            var z = feat.properties.zone;
            if (!zoneGroups[z]) zoneGroups[z] = { color: feat.properties.color, label: feat.properties.label, rings: [], bbox: [Infinity, Infinity, -Infinity, -Infinity] };
            feat.geometry.coordinates.forEach(function (ring) {
                zoneGroups[z].rings.push(ring);
                ring.forEach(function (pt) {
                    var px = toPixel(pt[0], pt[1]);
                    if (px[0] < zoneGroups[z].bbox[0]) zoneGroups[z].bbox[0] = px[0];
                    if (px[1] < zoneGroups[z].bbox[1]) zoneGroups[z].bbox[1] = px[1];
                    if (px[0] > zoneGroups[z].bbox[2]) zoneGroups[z].bbox[2] = px[0];
                    if (px[1] > zoneGroups[z].bbox[3]) zoneGroups[z].bbox[3] = px[1];
                });
            });
        });

        /* Pass 1 — semi-transparent fill (45% opacity) */
        Object.keys(zoneGroups).forEach(function (z) {
            var g = zoneGroups[z];
            var hex = g.color || '#1a9850';
            var r = parseInt(hex.slice(1, 3), 16);
            var gv = parseInt(hex.slice(3, 5), 16);
            var b = parseInt(hex.slice(5, 7), 16);
            ctx.fillStyle = 'rgba(' + r + ',' + gv + ',' + b + ',0.45)';
            g.rings.forEach(function (ring) {
                ctx.beginPath();
                ring.forEach(function (pt, i) {
                    var px = toPixel(pt[0], pt[1]);
                    if (i === 0) ctx.moveTo(px[0], px[1]); else ctx.lineTo(px[0], px[1]);
                });
                ctx.closePath();
                ctx.fill();
            });
        });

        /* Pass 2 — solid outlines (2px) */
        Object.keys(zoneGroups).forEach(function (z) {
            var g = zoneGroups[z];
            ctx.strokeStyle = g.color || '#1a9850';
            ctx.lineWidth = 2;
            g.rings.forEach(function (ring) {
                ctx.beginPath();
                ring.forEach(function (pt, i) {
                    var px = toPixel(pt[0], pt[1]);
                    if (i === 0) ctx.moveTo(px[0], px[1]); else ctx.lineTo(px[0], px[1]);
                });
                ctx.closePath();
                ctx.stroke();
            });
        });

        /* Pass 3 — zone name labels centered in each zone's pixel bbox */
        var fontSize = Math.max(10, Math.min(24, Math.round(w / 30)));
        ctx.font = 'bold ' + fontSize + 'px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        Object.keys(zoneGroups).forEach(function (z) {
            var g = zoneGroups[z];
            if (!isFinite(g.bbox[0])) return;
            var cx = (g.bbox[0] + g.bbox[2]) / 2;
            var cy = (g.bbox[1] + g.bbox[3]) / 2;
            /* Dark outline for legibility */
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 3;
            ctx.strokeText(g.label, cx, cy);
            ctx.fillStyle = '#1f2933';
            ctx.fillText(g.label, cx, cy);
        });

        return canvas.toDataURL('image/png');
    }

    function exportPDF() {
        var printWin = window.open('', '_blank');
        if (!printWin) { alert('Please allow popups for PDF export.'); return; }

        /* ── Build summary data ── */
        var groups = {};
        var totalArea = 0, totalProduct = 0;
        state.features.forEach(function (f) {
            var z = f.properties.zone;
            var ac = Number(f.properties.area_acres) || 0;
            totalArea += ac;
            if (!groups[z]) groups[z] = { zone: z, label: f.properties.label, color: f.properties.color, acres: 0 };
            groups[z].acres += ac;
        });
        var zonesHtml = '';
        Object.keys(groups).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (z) {
            var g = groups[z];
            var rate = state.zoneRates[z] || 0;
            totalProduct += g.acres * rate;
            zonesHtml += '<tr>' +
                '<td><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:' + g.color + ';vertical-align:middle;margin-right:6px"></span>' + g.label + '</td>' +
                '<td style="text-align:right">' + fmtAcres(g.acres) + ' ac</td>' +
                '<td style="text-align:right">' + rate + ' ' + state.rxUnit + '</td>' +
                '<td style="text-align:right;font-weight:700">' + (g.acres * rate).toFixed(1) + ' ' + state.rxUnit + '</td>' +
                '</tr>';
        });

        /* ── Capture images ── */
        var classifiedDataURL = buildClassifiedDataURL();
        var polygonDataURL    = buildPolygonDataURL();

        /* ── Timestamp ── */
        var now = new Date();
        var dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

        /* ── Legend HTML ── */
        var n = state.currentBreaks ? state.currentBreaks.length + 1 : 3;
        var legendHtml = '';
        for (var z = 1; z <= n; z++) {
            var color = zoneStyle(z, n);
            var name = zoneName(z, n);
            var range = state.currentBreaks ? classRange(z, state.currentBreaks, classBounds($('zoneMethod').value)) : { min: 0, max: 1 };
            legendHtml += '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">' +
                '<span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:' + color.hex + '"></span>' +
                '<span style="font-weight:600;font-size:13px">' + name + '</span>' +
                '<span style="color:#6b7280;font-size:12px">' + fmt(range.min) + ' – ' + fmt(range.max) + '</span>' +
                '</div>';
        }

        printWin.document.write('<!DOCTYPE html><html><head>' +
            '<meta charset="UTF-8"><title>Agroptics Prescription Report</title>' +
            '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
            '<style>' +
            '*{box-sizing:border-box;margin:0;padding:0}' +
            'body{font-family:Inter,"Segoe UI",sans-serif;background:#fff;color:#1f2933;font-size:13px}' +
            '.page{max-width:800px;margin:0 auto;padding:40px 32px}' +
            '.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1a9850;padding-bottom:16px;margin-bottom:24px}' +
            '.header-left h1{font-size:22px;color:#1a9850;font-weight:800;letter-spacing:-0.3px}' +
            '.header-left p{font-size:12px;color:#6b7280;margin-top:4px}' +
            '.header-right{text-align:right;font-size:12px;color:#6b7280}' +
            '.meta-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}' +
            '.meta-card{background:#f7f8f9;border:1px solid #e2e6ea;border-radius:8px;padding:10px 12px}' +
            '.meta-card .label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#9aa3ad;margin-bottom:3px}' +
            '.meta-card .value{font-size:14px;font-weight:700;color:#1f2933}' +
            'h2{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;margin-bottom:10px;margin-top:24px}' +
            '.img-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}' +
            '.img-box{background:#f7f8f9;border:1px solid #e2e6ea;border-radius:10px;overflow:hidden}' +
            '.img-box img{width:100%;display:block;object-fit:contain;max-height:240px;background:#2b2b2b}' +
            '.img-box .caption{font-size:11px;font-weight:600;color:#6b7280;padding:8px 10px;text-align:center;background:#f7f8f9;border-top:1px solid #e2e6ea}' +
            'table{width:100%;border-collapse:collapse}' +
            'th,td{padding:8px 12px;border-bottom:1px solid #eef0f2;text-align:left;font-size:12px}' +
            'th{background:#f7f8f9;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280}' +
            'tr:last-child td{border-bottom:none}' +
            '.totals-bar{display:flex;gap:16px;margin-top:16px}' +
            '.total-card{flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 14px}' +
            '.total-card .label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#1a9850;margin-bottom:4px}' +
            '.total-card .value{font-size:20px;font-weight:800;color:#1a9850}' +
            '.legend-box{background:#f7f8f9;border:1px solid #e2e6ea;border-radius:8px;padding:12px 14px;margin-bottom:24px}' +
            '.footer{margin-top:32px;padding-top:16px;border-top:1px solid #e2e6ea;font-size:11px;color:#9aa3ad;display:flex;justify-content:space-between}' +
            '@media print{.page{padding:20px}.no-break{page-break-inside:avoid}}' +
            '</style></head><body><div class="page">' +
            /* Header */
            '<div class="header">' +
            '<div class="header-left"><h1>Agroptics Prescription Report</h1><p>' + state.rxType.charAt(0).toUpperCase() + state.rxType.slice(1) + ' Prescription Map</p></div>' +
            '<div class="header-right"><strong>' + dateStr + '</strong><br>Generated by Agroptics</div>' +
            '</div>' +
            /* Meta cards */
            '<div class="meta-grid">' +
            '<div class="meta-card"><div class="label">Rx Type</div><div class="value">' + state.rxType.charAt(0).toUpperCase() + state.rxType.slice(1) + '</div></div>' +
            '<div class="meta-card"><div class="label">Unit</div><div class="value">' + state.rxUnit + '</div></div>' +
            '<div class="meta-card"><div class="label">Method</div><div class="value">' + methodLabel($('zoneMethod').value) + '</div></div>' +
            '<div class="meta-card"><div class="label">Zones</div><div class="value">' + zoneCount() + '</div></div>' +
            '</div>' +
            /* Maps — Image 1: Polygons only (Classified layer OFF) | Image 2: Classified raster (Polygons layer OFF) */
            '<h2>Prescription Maps</h2>' +
            '<div class="img-grid no-break">' +
            /* LEFT: Polygons only — "Classified OFF, Polygons ON" */
            '<div class="img-box">' +
            (polygonDataURL
                ? '<img src="' + polygonDataURL + '" alt="Zone Polygons">'
                : '<div style="height:200px;display:flex;align-items:center;justify-content:center;color:#9aa3ad">No polygons</div>') +
            '<div class="caption">Zone Polygons &nbsp;·&nbsp; Classified layer OFF</div></div>' +
            /* RIGHT: Classified raster — "Polygons OFF, Classified ON" */
            '<div class="img-box">' +
            (classifiedDataURL
                ? '<img src="' + classifiedDataURL + '" alt="Classified Raster">'
                : '<div style="height:200px;display:flex;align-items:center;justify-content:center;color:#9aa3ad">No image</div>') +
            '<div class="caption">Classified Raster &nbsp;·&nbsp; Polygons layer OFF</div></div>' +
            '</div>' +
            /* Legend */
            '<h2>Zone Legend</h2>' +
            '<div class="legend-box no-break">' + legendHtml + '</div>' +
            /* Table */
            '<h2>Zone Summary</h2>' +
            '<div class="no-break"><table><thead><tr>' +
            '<th>Zone</th><th style="text-align:right">Area (ac)</th>' +
            '<th style="text-align:right">Rate (' + state.rxUnit + ')</th>' +
            '<th style="text-align:right">Total Product</th>' +
            '</tr></thead><tbody>' + zonesHtml + '</tbody></table></div>' +
            /* Totals */
            '<div class="totals-bar no-break">' +
            '<div class="total-card"><div class="label">Total Area</div><div class="value">' + fmtAcres(totalArea) + ' ac</div></div>' +
            '<div class="total-card"><div class="label">Total Product</div><div class="value">' + totalProduct.toFixed(1) + ' ' + state.rxUnit + '</div></div>' +
            '</div>' +
            /* Footer */
            '<div class="footer"><span>Agroptics Prescription Demo</span><span>' + dateStr + '</span></div>' +
            '</div></body></html>');
        printWin.document.close();
        /* Small delay to let fonts/images render before print dialog */
        setTimeout(function () { printWin.print(); }, 800);
    }

    /* ═══════════ EXPORT — Classified Image ══════════════════════ */
    function exportClassifiedImage() {
        if (!state.classifiedGrid || !state.ndvi) return;
        var n = state.currentBreaks ? state.currentBreaks.length + 1 : 3;
        var canvas = document.createElement('canvas');
        canvas.width = state.width;
        canvas.height = state.height;
        var ctx = canvas.getContext('2d');
        var img = ctx.createImageData(state.width, state.height);
        var colors = [];
        for (var z = 1; z <= n; z++) colors[z] = zoneStyle(z, n);
        for (var i = 0; i < state.classifiedGrid.length; i++) {
            var o = i * 4;
            var cls = state.classifiedGrid[i];
            if (!cls || !colors[cls]) { img.data[o + 3] = 0; continue; }
            img.data[o] = colors[cls].r;
            img.data[o + 1] = colors[cls].g;
            img.data[o + 2] = colors[cls].b;
            img.data[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        canvas.toBlob(function (blob) {
            downloadBlob(blob, state.rxType + '_classified.png');
        }, 'image/png');
    }

    function downloadBlob(blob, filename) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    }

    /* ═══════════ PRESCRIPTION TYPE ══════════════════════════════ */
    function setRxType(type) {
        state.rxType = type;
        /* Update tabs */
        var tabs = document.querySelectorAll('.rx-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle('is-active', tabs[i].dataset.rx === type);
        }
        /* Update unit picker */
        var units = RX_UNITS[type] || [];
        /* Keep the hidden select in sync */
        var sel = $('unitSelect');
        sel.innerHTML = '';
        units.forEach(function (u) {
            var opt = document.createElement('option');
            opt.value = u.value; opt.textContent = u.label;
            sel.appendChild(opt);
        });
        state.rxUnit = units[0] ? units[0].value : '';
        /* Rebuild the visual unit-picker menu */
        rebuildUnitPicker(units, state.rxUnit);

        /* Show/hide index group */
        $('indexGroup').style.display = (type === 'irrigation') ? 'none' : '';

        /* Reset rates to defaults for this type */
        state.zoneRates = {};
        if (state.features.length) {
            updateZoneCombinedList(state.features);
            updateTotals(state.features);
        }
    }

    /* ═══════════ UNIT PICKER ════════════════════════════════════ */
    function rebuildUnitPicker(units, selected) {
        var btn = $('unitPickerBtn');
        var menu = $('unitPickerMenu');
        if (!btn || !menu) return;
        menu.innerHTML = '';
        units.forEach(function (u) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'unit-picker-item' + (u.value === selected ? ' is-selected' : '');
            item.textContent = u.label;
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                state.rxUnit = u.value;
                $('unitSelect').value = u.value;
                btn.textContent = u.label;
                /* Mark selected */
                menu.querySelectorAll('.unit-picker-item').forEach(function (el) {
                    el.classList.toggle('is-selected', el === item);
                });
                menu.hidden = true;
                $('unitPicker').classList.remove('is-open');
                if (state.features.length) {
                    updateZoneCombinedList(state.features);
                    updateTotals(state.features);
                }
            });
            menu.appendChild(item);
        });
        btn.textContent = (units[0] ? units[0].label : '');
    }

    function bindUnitPicker() {
        var picker = $('unitPicker');
        var btn = $('unitPickerBtn');
        var menu = $('unitPickerMenu');
        if (!picker || !btn || !menu) return;
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var willOpen = menu.hidden;
            closeUnitPicker();
            closePickers();
            closeExportMenu();
            if (willOpen) {
                menu.hidden = false;
                picker.classList.add('is-open');
            }
        });
    }

    function closeUnitPicker() {
        var picker = $('unitPicker');
        var menu = $('unitPickerMenu');
        if (picker) picker.classList.remove('is-open');
        if (menu) menu.hidden = true;
    }

    /* ═══════════ BREAK EDITOR ═══════════════════════════════════ */
    function updateBreakEditor() {
        var method = $('zoneMethod').value;
        var group = $('tableBreaksGroup');
        if (method !== 'table') {
            group.style.display = 'none';
            return;
        }
        group.style.display = '';
        var n = zoneCount();
        var editor = $('breakEditor');
        editor.innerHTML = '';
        var defaults = tableBreaks(n);
        for (var i = 0; i < n - 1; i++) {
            var row = document.createElement('div');
            row.className = 'break-row';
            row.innerHTML = '<span>Break ' + (i + 1) + ':</span>' +
                '<input type="number" min="0" max="1" step="0.01" value="' + (defaults[i] != null ? defaults[i] : (i + 1) / n) + '" />';
            editor.appendChild(row);
            row.querySelector('input').addEventListener('change', function () {
                scheduleZones();
            });
        }
    }

    /* ═══════════ CUSTOM PICKER ══════════════════════════════════ */
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
            closeExportMenu();
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

    /* ═══════════ EXPORT MENU ════════════════════════════════════ */
    function closeExportMenu() {
        var menu = $('exportMenu');
        if (menu) menu.hidden = true;
    }

    function positionAndOpenExportMenu() {
        var btn = $('exportBtn');
        var menu = $('exportMenu');
        if (!btn || !menu) return;
        var rect = btn.getBoundingClientRect();
        /* Open upward so it's never clipped inside the panel */
        menu.hidden = false;
        var menuH = menu.offsetHeight || 180; /* approximate if not yet painted */
        menu.style.left = rect.left + 'px';
        menu.style.top = (rect.top - menuH - 6) + 'px';
        /* Ensure it doesn't go off the top of the viewport */
        if (parseFloat(menu.style.top) < 8) {
            menu.style.top = (rect.bottom + 6) + 'px'; /* fall back: open downward */
        }
    }

    /* ═══════════ LOAD ═══════════════════════════════════════════ */
    async function loadBuffer(buffer, name) {
        setMessage('Loading index');
        try {
            await parseGeoTIFF(buffer, name);
        } catch (err) {
            console.error(err);
            setMessage(err.message || 'Could not read GeoTIFF');
        }
    }

    /* ═══════════ FIELD NOTES ════════════════════════════════════ */
    function updateFieldNotes() {
        $('zoneNote').textContent = optionHint($('zoneCount'));
        $('methodNote').textContent = optionHint($('zoneMethod'));
        $('aggNote').textContent = optionHint($('zoneAgg'));
        $('acreNote').textContent = optionHint($('minAcres'));
        var indexSel = $('indexSelect');
        var indexNote = $('indexNote');
        if (indexSel && indexNote) {
            indexNote.textContent = optionHint(indexSel);
        }
    }

    function optionHint(select) {
        var opt = select.options[select.selectedIndex];
        return opt ? (opt.getAttribute('data-hint') || '') : '';
    }

    function scheduleZones() {
        clearTimeout(state.regenTimer);
        updateFieldNotes();
        updateBreakEditor();
        generateZones();
    }

    /* ═══════════ BIND UI ════════════════════════════════════════ */
    function bindUi() {
        enhanceSelect($('zoneCount'));
        enhanceSelect($('zoneMethod'));
        enhanceSelect($('zoneAgg'));
        enhanceSelect($('minAcres'));
        enhanceSelect($('indexSelect'));
        bindUnitPicker();
        document.addEventListener('click', function () {
            closePickers(); closeExportMenu(); closeUnitPicker();
        });

        /* File input */
        $('tifInput').addEventListener('change', function (e) {
            var file = e.target.files && e.target.files[0];
            if (!file) return;
            file.arrayBuffer().then(function (buf) { loadBuffer(buf, file.name); });
        });

        /* Controls */
        $('minAcres').addEventListener('change', scheduleZones);
        $('zoneCount').addEventListener('change', function () {
            state.zoneRates = {};
            scheduleZones();
        });
        $('zoneMethod').addEventListener('change', scheduleZones);
        $('zoneAgg').addEventListener('change', scheduleZones);
        $('smoothToggle').addEventListener('change', scheduleZones);
        $('layerImage').addEventListener('change', applyLayers);
        $('layerPolygons').addEventListener('change', applyLayers);
        $('indexSelect').addEventListener('change', updateFieldNotes);

        /* Prescription tabs */
        var tabs = document.querySelectorAll('.rx-tab');
        for (var t = 0; t < tabs.length; t++) {
            tabs[t].addEventListener('click', function () { setRxType(this.dataset.rx); });
        }

        /* Export button — position menu via fixed coords so it's never clipped */
        $('exportBtn').addEventListener('click', function (e) {
            e.stopPropagation();
            var menu = $('exportMenu');
            var willOpen = menu.hidden;
            closePickers(); closeUnitPicker(); closeExportMenu();
            if (willOpen) positionAndOpenExportMenu();
        });

        /* Export items */
        var exportItems = document.querySelectorAll('.export-item');
        for (var ei = 0; ei < exportItems.length; ei++) {
            exportItems[ei].addEventListener('click', function (e) {
                e.stopPropagation();
                closeExportMenu();
                var format = this.dataset.format;
                if (format === 'geojson') exportGeoJSON();
                else if (format === 'shapefile') exportShapefile();
                else if (format === 'pdf') exportPDF();
                else if (format === 'image') exportClassifiedImage();
            });
        }

        /* Initial state */
        setRxType('irrigation');
        updateFieldNotes();
        updateBreakEditor();
    }

    /* ═══════════ INIT ═══════════════════════════════════════════ */
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
