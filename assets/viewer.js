/* Settings shared by every RTI page using this assets/viewer.js. */
const DATASET_VIEWER_OPTIONS = Object.freeze({
    iconVisible: true,             // true: show your icon; false: hide it everywhere.
    iconUrl: 'icon.png',           // File beside this viewer.js, not beside each PTM.
    iconHref: 'https://infinity-eccch.eu/', // Use null for a non-clickable icon.
    iconAlt: 'Project website'
});
// Capture this during script execution; document.currentScript is null later.
const DATASET_ASSETS_BASE = new URL('./', document.currentScript?.src || document.baseURI).href;

/* UI for the unmodified OpenLIME renderer. See README.md for the local source revision. */
let _viewerConfig = {};
let _iconElement = null;
let _iconVisible = false;
let _loadingProgress = 0;
let _toolbarDockObserver = null;

function _setLoadingProgress(progress) {
    const status = document.getElementById('viewer-status');
    if (!status) return;
    _loadingProgress = Math.max(_loadingProgress, Math.min(1, Math.max(0, progress)));
    status.style.setProperty('--load-progress', String(_loadingProgress));
    status.setAttribute('aria-valuenow', String(Math.round(_loadingProgress * 100)));
}

/* Read native texture completion counters. No fetch, coefficient or shader is replaced. */
function _trackLayerLoading(layer, lime) {
    let finished = false;
    let timer;
    function finish() {
        if (finished) return;
        finished = true;
        window.clearInterval(timer);
        _setLoadingProgress(1);
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        window.setTimeout(() => {
            document.getElementById('viewer-status').hidden = true;
            document.getElementById('demo').classList.toggle('viewer-loading', false);
            lime.redraw();
        }, reduced ? 0 : 200);
    }
    function update() {
        if (finished) return;
        const count = layer.shader?.samplers.filter(sampler => sampler.load !== false).length || 0;
        if (!count) return;
        const tiles = [...layer.tiles.values()];
        const expected = tiles.length * count;
        const remaining = tiles.reduce((sum, tile) => sum + Math.max(0, tile.missing ?? count), 0);
        _setLoadingProgress(expected ? 0.1 + 0.9 * (expected - remaining) / expected : 0.1);
        if (tiles.some(tile => tile.missing === 0) && layer.requested.size === 0) finish();
    }
    timer = window.setInterval(update, 100);
    layer.addEvent('update', update);
    layer.addEvent('loaded', finish);
    update();
}

async function _autodetect(rtiUrl) {
    for (const [file, layout] of [
        ['plane_0.tzi', 'tarzoom'], ['plane_0.dzi', 'deepzoom'],
        ['planes.tzi', 'itarzoom'], ['plane_0.jpg', 'image']
    ]) {
        const response = await fetch(new URL(file, rtiUrl));
        if (response.status === 200) return layout;
    }
    throw new Error('No RTI image or tiles were found beside info.json.');
}

async function _autodetectNormals(layout, rtiUrl) {
    const file = { tarzoom: 'normals.tzi', deepzoom: 'normals.dzi', image: 'normals.jpg' }[layout];
    return file ? (await fetch(new URL(file, rtiUrl))).status === 200 : false;
}

/* Rotation belongs to the view: keep the light in image coordinates. Calling the
   base draw method avoids LayerRTI's camera-dependent light rotation. The upstream
   interpolation, shader, coefficients, texture upload and color pipeline stay intact. */
function _createPresentationLayer(OpenLIME, options) {
    class PresentationRTILayer extends OpenLIME.LayerRTI {
        getMode() {
            // Tiled Sketch is implemented upstream as Normals + a Sketch filter.
            if (this.shader?.filters.some(filter => filter.name === 'ShaderFilterSketch')) return 'sketch';
            return super.getMode();
        }

        draw(transform, viewport) {
            return OpenLIME.Layer.prototype.draw.call(this, transform, viewport);
        }

        setMode(mode) {
            if (mode === this.getMode()) return;
            const light = this.shader.uniforms.light?.value;
            super.setMode(mode);
            // Refresh native reference weights when re-entering an analysis view.
            // Light must immediately restore the last direction, without another drag.
            if (mode === 'light' && light) this.shader.setLight(light);
            else if (this.shader.uniforms.base1) this.shader.uniforms.base1.value = undefined;
        }
    }
    const { type, ...layerOptions } = options;
    return new PresentationRTILayer(layerOptions);
}

/* Presentation-only camera: zoom-out must accommodate the rotated image. */
function _createViewCamera(OpenLIME) {
    class ViewCamera extends OpenLIME.Camera {
        getGlCurrentTransform(time) {
            this.annotationFrameTime = time;
            return super.getGlCurrentTransform(time);
        }

        _updateMinimumZoom(angle) {
            if (!this.viewport || this.boundingBox.isEmpty()) return;
            const rotated = new OpenLIME.Transform({ a: angle }).transformBox(this.boundingBox);
            this.minZoom = Math.min(this.viewport.dx / rotated.width(), this.viewport.dy / rotated.height()) * this.minScreenFraction;
            this.maxZoom = Math.max(this.maxZoom, this.minZoom);
        }

        updateBounds(box, minScale) {
            super.updateBounds(box, minScale);
            this._updateMinimumZoom(this.target.a);
        }

        setPosition(dt, x, y, z, a, easing) {
            this._updateMinimumZoom(a);
            super.setPosition(dt, x, y, z, a, easing);
        }
    }
    return new ViewCamera();
}

async function _initLayers(config, OpenLIME) {
    const rtiUrl = new URL(config.rtiUrl, document.baseURI);
    const layout = await _autodetect(rtiUrl);
    _setLoadingProgress(0.05);
    const normals = await _autodetectNormals(layout, rtiUrl);
    _setLoadingProgress(0.08);
    const lime = new OpenLIME.Viewer('#demo', {
        background: 'black', autofit: false, camera: _createViewCamera(OpenLIME)
    });
    lime.camera.maxFixedZoom = 4;

    // No setMode on startup: upstream defaults to standard RTI (Light).
    const baseLayer = _createPresentationLayer(OpenLIME, {
        layout, type: 'rti', url: rtiUrl.href, normals, label: config.rtiLabel || 'RTI'
    });
    lime.canvas.addLayer('RTI', baseLayer);
    // Fit the RTI once. Later overlay loading, toggles and size updates must not
    // reset the user's rotation, zoom, pan or an in-progress camera animation.
    let initialFitDone = false;
    const fitInitialView = () => {
        if (initialFitDone || baseLayer.status !== 'ready' || !lime.camera.viewport || lime.camera.boundingBox.isEmpty()) return;
        initialFitDone = true;
        lime.camera.fitCameraBox(0);
    };
    lime.canvas.addEvent('updateSize', fitInitialView);
    baseLayer.addEvent('ready', fitInitialView);
    fitInitialView();
    window.lime = lime;
    window._rtiBaseLayer = baseLayer;
    window._vectorLayer = null;

    if (config.vectorUrl) {
        window._vectorLayer = new OpenLIME.Layer({
            type: 'image', url: new URL(config.vectorUrl, document.baseURI).href,
            overlay: true, visible: false, zindex: 10, label: config.vectorLabel || 'Vector'
        });
        lime.canvas.addLayer('vector', window._vectorLayer);
    }

    OpenLIME.Skin.setUrl(config.skinUrl);
    const ui = new OpenLIME.UIBasic(lime, { skin: config.skinUrl, showLightDirections: true, autoFit: false });
    window._rtiUI = ui;
    ui.actions.zoomin.display = true;
    ui.actions.zoomout.display = true;
    ui.actions.ruler.display = true;
    ui.actions.ruler.key = 'c';
    ui.actions.rotate.display = true;
    ui.actions.rotate.key = 'r';
    ui.actions.rotatealias = { key: 'R', display: false, task: ui.actions.rotate.task };
    ui.actions.snapshot.display = true;
    ui.actions.snapshot.key = 's';
    ui.actions.snapshot.task = () => window.rtiAnnotations ? window.rtiAnnotations.openSnapshot() : ui.snapshot();
    ui.actions.annotations = {
        title: 'Annotations', key: 'a', display: true,
        icon: window.RTIAnnotations.toolbarIcon,
        task: () => window.rtiAnnotations?.toggle()
    };
    ui.actions.annotationsUppercase = { key: 'A', display: false, task: ui.actions.annotations.task };
    for (const name of ['light', 'ruler']) {
        const nativeTask = ui.actions[name].task;
        ui.actions[name].task = event => { window.rtiAnnotations?.close(); nativeTask(event); };
    }
    for (const name of ['rotate', 'zoomin', 'zoomout', 'home', 'fullscreen']) {
        const nativeTask = ui.actions[name].task;
        ui.actions[name].task = event => { if (!window.rtiAnnotations?.stroke) nativeTask(event); };
    }
    ui.actions.rotatealias.task = ui.actions.rotate.task;
    ui.actions.light.active = config.lightActive ?? true;
    ui.actions.layers.display = true;
    ui.actions.layers.key = 'z';
    ui.actions.layers.task = toggleModeBar;
    ui.actions.help.display = true;
    ui.actions.help.task = toggleHelpPanel;
    ui.actions.vectortoggle = {
        title: 'Vector On/Off', key: 'v', display: false, task: toggleVectorLayer
    };
    const trailingActions = ['ruler', 'annotations', 'snapshot', 'help'];
    ui.actions = Object.fromEntries([
        ...Object.entries(ui.actions).filter(([name]) => !trailingActions.includes(name)),
        ...trailingActions.map(name => [name, ui.actions[name]])
    ]);
    ui.postInit = () => { _setupToolbarDock(); window.rtiAnnotations?.mountDock(); };

    _buildModeBar(baseLayer);
    baseLayer.addEvent('ready', () => {
        _buildModeBar(baseLayer);
        _syncModeBar();
    });
    baseLayer.addEvent('update', _syncModeBar);

    if (Number.isFinite(config.rotate) && config.rotate !== 0) {
        let applied = false;
        baseLayer.addEvent('loaded', () => {
            if (applied) return;
            applied = true;
            lime.camera.rotate(0, config.rotate);
        });
    }
    return { lime, ui, baseLayer, vectorLayer: window._vectorLayer };
}

function _buildModeBar(layer) {
    const bar = document.getElementById('mode-bar');
    const labels = {
        light: 'Light', normals: 'Normals', diffuse: 'Diffuse',
        diffuse_gain: 'Diffuse Gain', specular: 'Specular', sketch: 'Sketch'
    };
    bar.replaceChildren();
    const content = document.createElement('div');
    content.className = 'mode-panel-content';
    bar.appendChild(content);
    const buttons = document.createElement('div');
    buttons.className = 'mode-buttons';
    content.appendChild(buttons);
    for (const mode of layer.getModes()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'btn-' + mode;
        button.dataset.rtiMode = mode;
        button.textContent = labels[mode] || mode;
        button.addEventListener('click', () => setRTIMode(mode));
        buttons.appendChild(button);
    }
    const vector = document.createElement('button');
    vector.type = 'button';
    vector.id = 'btn-vector';
    vector.disabled = !window._vectorLayer;
    vector.addEventListener('click', toggleVectorLayer);
    buttons.appendChild(vector);
    const controls = document.createElement('div');
    controls.id = 'mode-controls';
    content.appendChild(controls);
    _syncModeBar();
}

function _syncModeBar() {
    const layer = window._rtiBaseLayer;
    if (!layer) return;
    const mode = layer.getMode();
    for (const button of document.querySelectorAll('[data-rti-mode]')) {
        const active = button.dataset.rtiMode === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    }
    const vector = document.getElementById('btn-vector');
    if (vector) {
        const visible = Boolean(window._vectorLayer?.visible);
        vector.classList.toggle('active', visible);
        vector.setAttribute('aria-pressed', String(visible));
        vector.textContent = visible ? 'Vector On' : 'Vector Off';
    }
    const controls = document.getElementById('mode-controls');
    if (!controls || controls.dataset.mode === mode) return;
    controls.dataset.mode = mode;
    const specs = {
        specular: [['Exponent', 'specular_exp', 'setSpecularExp', 1, 100, 1, 1]],
        diffuse_gain: [['Gain', 'diffuse_gain', 'setDiffuseGain', 1, 5, 0.1, 1]],
        sketch: [
            ['Width', 'sketch_width', 'setSketchWidth', 1, 100, 1, 100],
            ['Radius', 'sketch_radius', 'setSketchRadius', 1, 100, 1, 100]
        ]
    };
    const available = (specs[mode] || []).filter(([, uniform, method]) =>
        layer.shader.uniforms[uniform] && typeof layer.shader[method] === 'function');
    const expanded = available.length > 0;
    controls.inert = !expanded;
    controls.setAttribute('aria-hidden', String(!expanded));
    document.getElementById('mode-bar').classList.toggle('has-mode-controls', expanded);
    // Retain the last fields while collapsing so the height can animate to zero.
    if (!expanded) return;
    controls.replaceChildren();
    const clip = document.createElement('div');
    clip.className = 'mode-controls-clip';
    const fields = document.createElement('div');
    fields.className = 'mode-controls-fields';
    clip.appendChild(fields);
    controls.appendChild(clip);
    for (const [title, uniform, method, min, max, step, scale] of available) {
        const label = document.createElement('label');
        label.textContent = title + ' ';
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = layer.shader.uniforms[uniform].value * scale;
        input.setAttribute('aria-label', title);
        const value = document.createElement('output');
        value.textContent = input.value;
        input.addEventListener('input', () => {
            layer.shader[method](Number(input.value));
            value.textContent = input.value;
        });
        label.append(input, value);
        fields.appendChild(label);
    }
}

function _setupToolbarDock() {
    const toolbar = document.querySelector('.openlime-toolbar');
    const bar = document.getElementById('mode-bar');
    if (!toolbar || !bar || document.getElementById('viewer-dock')) return;
    const dock = document.createElement('div');
    dock.id = 'viewer-dock';
    const drawer = document.createElement('div');
    drawer.className = 'mode-drawer';
    toolbar.before(dock);
    drawer.appendChild(bar);
    dock.append(drawer, toolbar);

    // Share the toolbar width with help, measuring only when its size changes.
    const syncSize = () => {
        const bounds = toolbar.getBoundingClientRect();
        dock.style.setProperty('--toolbar-height', bounds.height + 'px');
        document.getElementById('demo').style.setProperty('--viewer-toolbar-height', bounds.height + 'px');
        document.getElementById('demo').style.setProperty('--viewer-menu-width', bounds.width + 'px');
    };
    syncSize();
    if (typeof ResizeObserver !== 'undefined') {
        _toolbarDockObserver = new ResizeObserver(syncSize);
        _toolbarDockObserver.observe(toolbar);
    }
    _syncToolbar();
}

function _syncToolbar() {
    const dock = document.getElementById('viewer-dock');
    if (dock) dock.classList.toggle('layers-open', document.getElementById('mode-bar').classList.contains('open'));
    for (const [name, id] of [['layers', 'mode-bar'], ['help', 'help-panel']]) {
        const button = document.querySelector('.openlime-button.openlime-' + name);
        if (!button) continue;
        button.setAttribute('aria-controls', id);
        button.setAttribute('aria-expanded', String(document.getElementById(id).classList.contains('open')));
        button.classList.toggle('viewer-action-active', document.getElementById(id).classList.contains('open'));
    }
}

async function initViewer(config) {
    _viewerConfig = config;
    _loadingProgress = 0;
    document.getElementById('skinCssLink').href = config.stylesheetUrl;
    const demo = document.getElementById('demo');
    demo.classList.toggle('viewer-loading', true);
    demo.insertAdjacentHTML('beforeend', `
        <div id="mode-bar" role="group" aria-label="Rendering modes" aria-hidden="true"></div>
        <div id="help-panel" role="dialog" aria-label="Viewer help" aria-hidden="true" inert>
            <button type="button" class="panel-close" aria-label="Close help">×</button>
            <h5>Light Control</h5>
            <ul>
                <li>Press <strong>L</strong> or click the light icon to activate interactive lighting.</li>
                <li>Drag on the image to reposition the virtual light source.</li>
            </ul>
            <h5>Rendering Modes</h5>
            <p>Press <strong>Z</strong> or click the layers icon to open the mode bar:</p>
            <ul>
                <li><strong>Light</strong> — Standard RTI with interactive lighting (default)</li>
                <li><strong>Normals</strong> — Surface normal map</li>
                <li><strong>Diffuse</strong> — Diffuse reflectance</li>
                <li><strong>Diffuse Gain</strong> — Enhanced diffuse reflectance with adjustable gain</li>
                <li><strong>Specular</strong> — Specular reflectance with adjustable exponent</li>
                <li><strong>Vector</strong> — Toggle vector overlay (also <strong>V</strong>)</li>
            </ul>
            <h5>Ruler</h5>
            <ul>
                <li>Press <strong>C</strong> or click the ruler icon to activate.</li>
                <li>Click two points on the image to measure the distance between them.</li>
            </ul>
            <h5>Annotations</h5>
            <ul>
                <li>Press <strong>A</strong> or click the annotation icon to open your saved drawings.</li>
                <li>Use <strong>+</strong> to create a drawing, then choose <strong>Finish drawing</strong> to add a name and description.</li>
                <li>Choose <strong>Save annotation</strong> to keep it in this browser.</li>
                <li>Switch between <strong>Pen</strong> and <strong>Navigate</strong> while drawing.</li>
                <li>Select a saved drawing to read, edit, hide or delete it. <strong>Find in image</strong> moves the view to that drawing.</li>
                <li>Download <strong>JSON</strong> for an editable backup or <strong>SVG</strong> for vector drawings. Import JSON on the same RTI image.</li>
            </ul>
            <h5>Save Image</h5>
            <ul>
                <li>Press <strong>S</strong> or click the camera icon to choose a PNG export.</li>
                <li>Choose <strong>RTI only</strong> or <strong>With annotations</strong>. Current light, rotation and zoom are preserved.</li>
                <li>Only saved, visible annotations are included in the image.</li>
            </ul>
            <h5>Keyboard Shortcuts</h5>
            <ul>
                <li><strong>L</strong> — Light control</li>
                <li><strong>Z</strong> — Toggle mode bar</li>
                <li><strong>V</strong> — Toggle vector overlay</li>
                <li><strong>C</strong> — Toggle ruler</li>
                <li><strong>R</strong> — Rotate view</li>
                <li><strong>A</strong> — Annotations</li>
                <li><strong>S</strong> — Save snapshot</li>
                <li><strong>+ / −</strong> — Zoom in / out</li>
                <li><strong>Home</strong> — Reset view</li>
                <li><strong>Esc</strong> — Close panels</li>
            </ul>
        </div>
        <div id="viewer-status" role="progressbar" aria-label="Loading model" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <span class="loading-measure" aria-hidden="true">LOADING MODEL</span>
            <span class="loading-line" aria-hidden="true"><span class="loading-fill"></span></span>
        </div>
    `);
    document.getElementById('mode-bar').inert = true;
    document.querySelector('#help-panel .panel-close').addEventListener('click', () => toggleHelpPanel(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            toggleHelpPanel(false);
            toggleModeBar(false);
        }
    });
    configureViewerIcon({ url: config.iconUrl, href: config.iconHref, visible: config.iconVisible === true });

    try {
        const OpenLIME = window.OpenLIME;
        if (!OpenLIME) throw new Error('openlime.min.js must be loaded before viewer.js.');
        const result = await _initLayers(config, OpenLIME);
        _trackLayerLoading(result.baseLayer, result.lime);
        window.rtiAnnotations = new window.RTIAnnotations(result, config);
        return { ...result, annotations: window.rtiAnnotations };
    } catch (error) {
        const status = document.getElementById('viewer-status');
        status.textContent = 'The RTI viewer could not be loaded.';
        status.setAttribute('role', 'alert');
        status.hidden = false;
        console.error(error);
        throw error;
    }
}

function _togglePanel(id, force) {
    const panel = document.getElementById(id);
    if (!panel) return false;
    const open = typeof force === 'boolean' ? force : !panel.classList.contains('open');
    if (open) {
        window.rtiAnnotations?.close();
        if (id === 'mode-bar') document.getElementById('viewer-dock')?.classList.remove('annotation-active');
    }
    panel.classList.toggle('open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    _syncToolbar();
    return open;
}

function toggleHelpPanel(force) { return _togglePanel('help-panel', force); }
function toggleModeBar(force) { return _togglePanel('mode-bar', force); }

function setRTIMode(mode) {
    const layer = window._rtiBaseLayer;
    if (!layer || layer.status !== 'ready' || !layer.getModes().includes(mode)) return false;
    layer.setMode(mode);
    _syncModeBar();
    return true;
}

function toggleVectorLayer() {
    const layer = window._vectorLayer;
    if (!layer) return false;
    layer.setVisible(!layer.visible);
    _syncModeBar();
    return layer.visible;
}

/* Hidden icons have no src and make no image request. Failed images stay hidden. */
function configureViewerIcon({ url, href, visible = false } = {}) {
    _viewerConfig.iconUrl = url || null;
    _viewerConfig.iconHref = href || null;
    if (_iconElement) _iconElement.remove();
    _iconElement = null;
    _iconVisible = false;
    if (!url) return false;
    const link = document.createElement('a');
    link.id = 'viewer-icon';
    link.hidden = true;
    if (href) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
    }
    const img = document.createElement('img');
    img.alt = _viewerConfig.iconAlt || 'Your icon';
    img.addEventListener('load', () => {
        if (_iconElement === link) link.hidden = !_iconVisible;
    });
    img.addEventListener('error', () => {
        if (_iconElement !== link) return;
        link.hidden = true;
        _iconVisible = false;
    });
    link.appendChild(img);
    document.getElementById('demo').appendChild(link);
    _iconElement = link;
    return setViewerIconVisible(visible);
}

function setViewerIconVisible(visible) {
    _iconVisible = Boolean(visible && _iconElement && _viewerConfig.iconUrl);
    if (!_iconElement) return false;
    const img = _iconElement.querySelector('img');
    _iconElement.hidden = true;
    if (_iconVisible) {
        if (!img.getAttribute('src')) img.src = _viewerConfig.iconUrl;
        else if (img.complete && img.naturalWidth > 0) _iconElement.hidden = false;
    }
    return _iconVisible;
}

function showViewerIcon() { return setViewerIconVisible(true); }
function hideViewerIcon() { return setViewerIconVisible(false); }
function toggleViewerIcon() { return setViewerIconVisible(!_iconVisible); }

/* Personal annotation editor. Runs outside the RTI renderer and never sets shader uniforms. */
(function (global) {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const FORMAT = 'openlime-personal-annotations';
    const COLORS = ['#ffcc00', '#ffffff', '#70d9ff', '#ff7f8d', '#90df9b'];
    const clone = value => JSON.parse(JSON.stringify(value));
    const uid = () => global.crypto?.randomUUID?.() || 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
    function fingerprint(text) {
        let a = 2166136261, b = 5381;
        for (let i = 0; i < text.length; i++) {
            a = Math.imul(a ^ text.charCodeAt(i), 16777619);
            b = Math.imul(b, 33) ^ text.charCodeAt(i);
        }
        return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
    }
    const escapeXML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
    const number = value => Number(value.toFixed(3));
    function pathData(points) {
        if (!points.length) return '';
        let d = `M${number(points[0][0])} ${number(points[0][1])}`;
        if (points.length === 1) return d + 'l0.01 0';
        for (let i = 1; i < points.length - 1; i++) {
            const p = points[i], next = points[i + 1];
            d += `Q${number(p[0])} ${number(p[1])} ${number((p[0] + next[0]) / 2)} ${number((p[1] + next[1]) / 2)}`;
        }
        return d + `L${number(points.at(-1)[0])} ${number(points.at(-1)[1])}`;
    }
    function project(point, camera, layer, size, viewport) {
        const p = layer.apply(point[0] - size.width / 2, size.height / 2 - point[1]);
        const screen = camera.apply(p.x, p.y);
        return [viewport.w / 2 + screen.x, viewport.h / 2 - screen.y];
    }
    function unproject(point, camera, layer, size, viewport) {
        const scene = camera.inverse().apply(point[0] - viewport.w / 2, viewport.h / 2 - point[1]);
        const image = layer.inverse().apply(scene.x, scene.y);
        return [image.x + size.width / 2, size.height / 2 - image.y];
    }
    function bounds(record) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const stroke of record.strokes) for (const [x, y] of stroke.points) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        return { x0, y0, x1, y1 };
    }
    function validateDocument(data, dataset) {
        if (!data || data.format !== FORMAT || data.version !== 1) throw new Error('This is not a supported annotation JSON file.');
        if (data.dataset?.signature !== dataset.signature || data.dataset?.width !== dataset.width || data.dataset?.height !== dataset.height)
            throw new Error('These annotations belong to a different RTI image. Nothing was imported.');
        if (!Array.isArray(data.annotations) || data.annotations.length > 200) throw new Error('An annotation file can contain up to 200 annotations.');
        const ids = new Set();
        let totalPoints = 0;
        return data.annotations.map(record => {
            if (!record || typeof record.id !== 'string' || !/^[\w-]{1,80}$/.test(record.id) || ids.has(record.id)) throw new Error('Invalid or repeated annotation ID.');
            ids.add(record.id);
            if (typeof record.label !== 'string' || !record.label.trim() || record.label.length > 120 || typeof record.description !== 'string' || record.description.length > 4000)
                throw new Error('Invalid annotation name or description.');
            if (!/^#[0-9a-f]{6}$/i.test(record.color) || !Number.isFinite(record.width) || record.width < 0.5 || record.width > 8)
                throw new Error('Invalid annotation style.');
            if (!Array.isArray(record.strokes) || !record.strokes.length || record.strokes.length > 500) throw new Error('Invalid annotation drawing.');
            const strokes = record.strokes.map(stroke => {
                if (!Array.isArray(stroke?.points) || !stroke.points.length || stroke.points.length > 30000) throw new Error('Invalid stroke.');
                totalPoints += stroke.points.length;
                if (totalPoints > 200000) throw new Error('This file contains too many drawing points.');
                return { points: stroke.points.map(point => {
                    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || point[0] < 0 || point[1] < 0 || point[0] > dataset.width || point[1] > dataset.height)
                        throw new Error('A drawing point lies outside this image.');
                    return [point[0], point[1]];
                }) };
            });
            return { id: record.id, label: record.label.trim(), description: record.description, color: record.color,
                width: record.width, visible: record.visible !== false, strokes,
                createdAt: typeof record.createdAt === 'string' ? record.createdAt.slice(0, 40) : '',
                updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt.slice(0, 40) : '' };
        });
    }
    function mergeRecords(existing, incoming, makeID = uid) {
        const merged = clone(existing), ids = new Set(merged.map(record => record.id));
        let added = 0;
        for (const record of incoming) {
            const sameID = merged.find(item => item.id === record.id);
            if (sameID && canonical(sameID) === canonical(record)) continue;
            const next = clone(record);
            if (ids.has(next.id)) next.id = makeID();
            ids.add(next.id); merged.push(next); added++;
        }
        if (merged.length > 200 || merged.reduce((sum, record) => sum + record.strokes.reduce((n, stroke) => n + stroke.points.length, 0), 0) > 200000)
            throw new Error('The combined annotations exceed the drawing limit. Export your current records before starting a new set.');
        return { records: merged, added };
    }
    function svgDocument(dataset, records) {
        const scale = Math.max(dataset.width, dataset.height) / 1600;
        const document = { format: FORMAT, version: 1, dataset, annotations: records };
        return `<svg xmlns="${NS}" viewBox="0 0 ${dataset.width} ${dataset.height}" width="${dataset.width}" height="${dataset.height}">`
            + `<title>RTI annotations</title><metadata>${escapeXML(JSON.stringify(document))}</metadata>`
            + records.map(record => `<g fill="none" stroke="${record.color}" stroke-width="${number(record.width * scale)}" stroke-linecap="round" stroke-linejoin="round">`
                + `<title>${escapeXML(record.label)}</title><desc>${escapeXML(record.description)}</desc>`
                + record.strokes.map(stroke => `<path d="${pathData(stroke.points)}"/>`).join('') + '</g>').join('') + '</svg>';
    }
    global.RTIAnnotationCore = Object.freeze({ canonical, fingerprint, pathData, project, unproject, bounds, validateDocument, mergeRecords, svgDocument, clone });

    class RTIAnnotations {
        static toolbarIcon = `<svg xmlns="${NS}" class="openlime-button openlime-annotations" width="81" height="81"><rect x="0" y="0" width="71" height="71" rx="12" style="fill:#fff;stroke:#666;stroke-width:2"/><g transform="translate(13,13) scale(1.875)"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" d="M12 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M10 14l-1 4 4-1L23 7a2.12 2.12 0 0 0-3-3L10 14zM18 6l3 3"/></g></svg>`;

        constructor(result, config) {
            this.lime = result.lime; this.ui = result.ui; this.layer = result.baseLayer; this.config = config;
            this.records = []; this.dataset = null; this.isOpen = false; this.allVisible = true;
            this.view = 'list'; this.selected = null; this.draft = null; this.tool = 'pen';
            this.icons = new Map(); this.notice = ''; this.storageFailed = false; this.stroke = null;
            this.controllerState = null; this.lastMatrix = ''; this.art = new Map();
            this.panel = document.createElement('section');
            this.panel.id = 'annotation-panel'; this.panel.className = 'annotation-panel';
            this.panel.setAttribute('aria-label', 'Annotations'); this.panel.setAttribute('aria-hidden', 'true'); this.panel.inert = true;
            this.panel.addEventListener('click', event => this.onPanelClick(event));
            this.panel.addEventListener('submit', event => { event.preventDefault(); this.saveDraft(); });
            this.panel.addEventListener('input', event => this.onPanelInput(event));
            this.panel.addEventListener('change', event => this.onPanelInput(event));
            this.panel.addEventListener('focusin', () => this.syncKeyboardViewport());
            this.panel.addEventListener('focusout', () => global.setTimeout(() => this.syncKeyboardViewport(), 0));
            this.fileInput = document.createElement('input'); this.fileInput.type = 'file'; this.fileInput.accept = '.json,application/json';
            this.fileInput.hidden = true; this.fileInput.addEventListener('change', () => this.importFile());
            this.lime.containerElement.append(this.panel, this.fileInput);
            this.createOverlay(); this.bindKeyboard(); this.mountDock(); this.render();
            this.lime.addEvent('draw', () => this.syncTransform());
            this.lime.addEvent('resize', () => { if (this.stroke) this.finishStroke(true); this.syncTransform(); });
            global.visualViewport?.addEventListener('resize', () => this.syncKeyboardViewport());
            global.visualViewport?.addEventListener('scroll', () => this.syncKeyboardViewport());
            this.ready = this.initialise().catch(error => { this.fatalError = error.message; this.render(); });
        }

        async initialise() {
            const response = await fetch(new URL(this.config.rtiUrl, document.baseURI));
            if (!response.ok) throw new Error('Annotation tools could not read this RTI image.');
            const info = await response.json();
            if (!(info.width > 0 && info.height > 0)) throw new Error('The RTI image dimensions are not available.');
            const signature = canonical(info);
            this.dataset = { signature, width: info.width, height: info.height };
            const url = new URL(this.config.rtiUrl, document.baseURI);
            this.storageKey = 'rti-annotations:v1:' + url.pathname + url.search + ':' + fingerprint(signature);
            try {
                const stored = global.localStorage.getItem(this.storageKey);
                if (stored) this.records = validateDocument(JSON.parse(stored), this.dataset);
            } catch (error) {
                this.storageFailed = true;
                this.notice = 'Browser storage is unavailable or contains unreadable records. Export JSON to keep your work.';
            }
            this.clipRect.setAttribute('width', info.width); this.clipRect.setAttribute('height', info.height);
            await this.loadIcons();
            this.renderArtwork(); this.render(); this.syncTransform();
        }

        async loadIcons() {
            const names = ['add', 'draw', 'pen', 'visible', 'hidden', 'edit', 'trash', 'export', 'ok', 'undo', 'redo', 'close'];
            if (!global.OpenLIME.Skin.svg && global.OpenLIME.Skin.loadSvg) await global.OpenLIME.Skin.loadSvg();
            await Promise.all(names.map(async name => {
                try {
                    const holder = document.createElement('span');
                    const svg = await global.OpenLIME.Skin.appendIcon(holder, '.openlime-' + name);
                    svg.classList.add('annotation-icon'); svg.setAttribute('aria-hidden', 'true');
                    for (const element of [svg, ...svg.querySelectorAll('*')]) {
                        element.removeAttribute('id');
                        if (element.style.fill && element.style.fill !== 'none') element.style.fill = 'currentColor';
                        if (element.style.stroke && element.style.stroke !== 'none') element.style.stroke = 'currentColor';
                    }
                    this.icons.set(name, svg);
                } catch (_) { /* Every icon-only control also has an accessible text fallback. */ }
            }));
        }

        mountDock() {
            const dock = document.getElementById('viewer-dock');
            if (!dock) return;
            dock.querySelector('.mode-drawer').appendChild(this.panel);
            const button = document.querySelector('.openlime-button.openlime-annotations');
            if (button) {
                button.setAttribute('aria-controls', 'annotation-panel'); button.setAttribute('role', 'button');
                button.setAttribute('tabindex', '0'); button.setAttribute('aria-label', 'Annotations');
                button.setAttribute('aria-expanded', String(this.isOpen));
                if (!button.dataset.annotationKeyboard) {
                    button.dataset.annotationKeyboard = 'true';
                    button.addEventListener('keydown', event => {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.toggle(); }
                    });
                }
            }
        }

        open(view) {
            this.mountDock();
            const dock = document.getElementById('viewer-dock');
            if (!dock) return;
            toggleModeBar(false); toggleHelpPanel(false);
            this.view = view || (this.draft ? this.draft.phase : 'list');
            this.isOpen = true; this.panel.inert = false; this.panel.setAttribute('aria-hidden', 'false');
            dock.classList.add('annotation-active', 'annotations-open');
            const button = document.querySelector('.openlime-button.openlime-annotations');
            button?.setAttribute('aria-expanded', 'true'); button?.classList.add('viewer-action-active');
            this.updateInteraction(); this.render(); this.renderArtwork();
        }

        close() {
            if (this.stroke) this.finishStroke();
            this.isOpen = false; this.panel.inert = true; this.panel.setAttribute('aria-hidden', 'true');
            document.getElementById('viewer-dock')?.classList.remove('annotations-open');
            const button = document.querySelector('.openlime-button.openlime-annotations');
            button?.setAttribute('aria-expanded', 'false'); button?.classList.remove('viewer-action-active');
            if (document.activeElement?.closest?.('#annotation-panel')) document.activeElement.blur();
            this.syncKeyboardViewport();
            this.updateInteraction(); this.renderArtwork();
        }
        toggle() { if (this.isOpen) this.close(); else this.open(); }

        syncKeyboardViewport() {
            const dock = document.getElementById('viewer-dock'), viewport = global.visualViewport;
            if (!dock || !viewport) return;
            const typing = this.isOpen && document.activeElement?.closest?.('#annotation-panel') && document.activeElement.matches('input,textarea');
            const offset = typing ? Math.max(0, global.innerHeight - viewport.height - viewport.offsetTop) : 0;
            dock.style.setProperty('--annotation-keyboard-offset', offset + 'px');
            const toolbar = dock.querySelector('.openlime-toolbar');
            const available = Math.max(60, viewport.height - (toolbar?.getBoundingClientRect().height || 100) - 32);
            dock.style.setProperty('--annotation-panel-available', available + 'px');
        }

        document(records = this.records) { return { format: FORMAT, version: 1, dataset: this.dataset, annotations: records }; }
        persist(message) {
            try {
                global.localStorage.setItem(this.storageKey, JSON.stringify(this.document()));
                this.storageFailed = false; this.notice = message || 'Saved in this browser.';
            } catch (_) {
                this.storageFailed = true; this.notice = 'Saved for this session only. Export JSON to keep your work.';
            }
        }

        createOverlay() {
            this.svg = document.createElementNS(NS, 'svg'); this.svg.classList.add('annotation-overlay');
            this.svg.setAttribute('aria-hidden', 'true'); this.svg.setAttribute('preserveAspectRatio', 'none');
            const defs = document.createElementNS(NS, 'defs');
            const clip = document.createElementNS(NS, 'clipPath'); clip.id = 'annotation-image-clip';
            this.clipRect = document.createElementNS(NS, 'rect'); clip.appendChild(this.clipRect); defs.appendChild(clip);
            this.group = document.createElementNS(NS, 'g'); this.group.setAttribute('clip-path', 'url(#annotation-image-clip)');
            this.svg.append(defs, this.group); this.lime.containerElement.appendChild(this.svg);
            this.svg.addEventListener('pointerdown', event => this.startStroke(event));
            this.svg.addEventListener('pointermove', event => this.moveStroke(event));
            this.svg.addEventListener('pointerup', event => this.endStroke(event));
            this.svg.addEventListener('pointercancel', event => this.endStroke(event, true));
            this.svg.addEventListener('lostpointercapture', () => { if (this.stroke) this.finishStroke(); });
            this.svg.addEventListener('click', event => {
                if (!this.isOpen || this.draft) return;
                const target = event.target.closest('[data-annotation-id]');
                if (target) { event.stopPropagation(); this.selected = target.dataset.annotationId; this.view = 'detail'; this.render(); this.renderArtwork(); }
            });
        }

        currentTransforms(time = performance.now()) {
            return { camera: this.lime.camera.getCurrentTransform(time), layer: this.layer.transform,
                size: this.dataset, viewport: this.lime.camera.viewport };
        }
        syncTransform() {
            if (!this.dataset || !this.lime.camera.viewport) return;
            const t = this.currentTransforms(this.lime.camera.annotationFrameTime || performance.now());
            const origin = project([0, 0], t.camera, t.layer, t.size, t.viewport);
            const x = project([1, 0], t.camera, t.layer, t.size, t.viewport);
            const y = project([0, 1], t.camera, t.layer, t.size, t.viewport);
            const matrix = [x[0] - origin[0], x[1] - origin[1], y[0] - origin[0], y[1] - origin[1], ...origin].join(' ');
            const key = matrix + ':' + t.viewport.w + ':' + t.viewport.h;
            if (key === this.lastMatrix) return;
            this.lastMatrix = key;
            this.svg.setAttribute('viewBox', `0 0 ${t.viewport.w} ${t.viewport.h}`);
            this.group.setAttribute('transform', `matrix(${matrix})`);
        }

        path(record, stroke, selectable) {
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', pathData(stroke.points)); path.setAttribute('fill', 'none');
            path.setAttribute('stroke', record.color); path.setAttribute('stroke-width', record.width);
            path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            if (selectable) path.dataset.annotationId = record.id;
            return path;
        }
        renderArtwork() {
            this.group.replaceChildren(); this.art.clear();
            for (const record of this.records) {
                if (!this.allVisible || !record.visible || record.id === this.draft?.id) continue;
                const group = document.createElementNS(NS, 'g');
                group.setAttribute('opacity', this.isOpen && (this.draft || (this.selected && this.selected !== record.id)) ? '0.3' : '1');
                const title = document.createElementNS(NS, 'title'); title.textContent = record.label; group.appendChild(title);
                for (const stroke of record.strokes) group.appendChild(this.path(record, stroke, true));
                this.group.appendChild(group); this.art.set(record.id, group);
            }
            if (this.draft) for (const stroke of this.draft.strokes) this.group.appendChild(this.path(this.draft, stroke, false));
            this.syncTransform();
        }

        updateInteraction() {
            const editing = Boolean(this.isOpen && this.draft);
            if (editing && !this.controllerState) {
                const controllers = new Set([...(this.lime.controllers || []), ...(this.layer.controllers || []), this.ui.lightcontroller, this.ui.panzoom, this.ui.ruler].filter(Boolean));
                this.controllerState = { light: this.ui.lightActive,
                    controllers: [...controllers].map(controller => ({ controller, active: controller.active, enabled: controller.enabled,
                        modifiers: controller.activeModifiers ? [...controller.activeModifiers] : undefined })) };
                this.ui.toggleLightController(false);
                for (const controller of controllers) if (controller.control === 'light') controller.active = false;
                if (this.ui.lightcontroller) this.ui.lightcontroller.active = false;
                if (this.ui.ruler) this.ui.ruler.enabled = false;
                this.ui.panzoom.active = true;
            } else if (!editing && this.controllerState) {
                this.ui.lightActive = this.controllerState.light;
                this.lime.containerElement.classList.toggle('openlime-light-active', Boolean(this.controllerState.light));
                for (const state of this.controllerState.controllers) {
                    state.controller.active = state.active;
                    if (state.enabled !== undefined) state.controller.enabled = state.enabled;
                    if (state.modifiers) state.controller.activeModifiers = state.modifiers;
                }
                this.controllerState = null;
            }
            this.painting = editing && this.view === 'draw' && this.tool === 'pen';
            this.svg.classList.toggle('annotation-painting', this.painting);
            this.svg.classList.toggle('annotation-selecting', this.isOpen && !this.draft);
        }

        begin(record = null) {
            if (!this.dataset) return;
            if (!record && this.records.length >= 200) { this.say('Export your records before adding more than 200 annotations.'); return; }
            this.draft = record ? clone(record) : { id: uid(), label: '', description: '', color: COLORS[0], width: 2.5,
                visible: true, strokes: [], createdAt: new Date().toISOString(), updatedAt: '' };
            this.draft.phase = 'draw'; this.redo = []; this.tool = 'pen'; this.selected = record?.id || null;
            this.allVisible = true; this.notice = ''; this.open('draw');
        }

        startStroke(event) {
            if (!this.painting || this.stroke || event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            // Use the target time: this upstream build's isComplete flag is unreliable.
            if (performance.now() < this.lime.camera.target.t) { this.say('Let the view finish moving, then draw.'); return; }
            if (this.draft.strokes.length >= 500) { this.say('This annotation has reached its stroke limit.'); return; }
            const transform = this.currentTransforms();
            const rect = this.svg.getBoundingClientRect();
            const point = unproject([event.clientX - rect.left, event.clientY - rect.top], transform.camera, transform.layer, transform.size, transform.viewport);
            if (point[0] < 0 || point[1] < 0 || point[0] > this.dataset.width || point[1] > this.dataset.height) return;
            this.stroke = { pointer: event.pointerId, points: [], transform, rect, total: this.draft.strokes.reduce((n, s) => n + s.points.length, 0) };
            this.activePath = this.path(this.draft, { points: [] }, false); this.group.appendChild(this.activePath);
            this.svg.setPointerCapture(event.pointerId); this.addPoints([event]);
        }
        addPoints(events) {
            const stroke = this.stroke;
            for (const event of events) {
                if (stroke.total + stroke.points.length >= 30000) break;
                const screen = [event.clientX - stroke.rect.left, event.clientY - stroke.rect.top];
                if (stroke.lastScreen && Math.hypot(screen[0] - stroke.lastScreen[0], screen[1] - stroke.lastScreen[1]) < 1.2) continue;
                const p = unproject(screen, stroke.transform.camera, stroke.transform.layer, this.dataset, stroke.transform.viewport);
                p[0] = Math.max(0, Math.min(this.dataset.width, p[0])); p[1] = Math.max(0, Math.min(this.dataset.height, p[1]));
                stroke.points.push(p.map(number)); stroke.lastScreen = screen;
            }
            this.activePath.setAttribute('d', pathData(stroke.points));
        }
        moveStroke(event) {
            if (!this.stroke || event.pointerId !== this.stroke.pointer) return;
            event.preventDefault(); event.stopPropagation();
            const points = event.getCoalescedEvents?.(); this.addPoints(points?.length ? points : [event]);
        }
        endStroke(event, cancelled = false) {
            if (!this.stroke || event.pointerId !== this.stroke.pointer) return;
            event.preventDefault(); event.stopPropagation();
            if (!cancelled) this.addPoints([event]);
            this.finishStroke(cancelled);
        }
        finishStroke(cancelled = false) {
            if (!this.stroke) return;
            const stroke = this.stroke; this.stroke = null;
            if (!cancelled && stroke.points.length) { this.draft.strokes.push({ points: stroke.points }); this.redo = []; }
            if (this.svg.hasPointerCapture(stroke.pointer)) this.svg.releasePointerCapture(stroke.pointer);
            this.renderArtwork(); this.render();
        }
        undoStroke() {
            if (!this.draft || this.stroke) return;
            const stroke = this.draft.strokes.pop(); if (stroke) this.redo.push(stroke);
            this.renderArtwork(); this.render();
        }
        redoStroke() {
            if (!this.draft || this.stroke) return;
            const stroke = this.redo.pop(); if (stroke) this.draft.strokes.push(stroke);
            this.renderArtwork(); this.render();
        }

        saveDraft() {
            if (!this.draft?.label.trim()) { this.say('Please give this annotation a name.'); this.panel.querySelector('[name="annotation-name"]')?.focus(); return; }
            if (!this.draft.strokes.length) { this.say('Draw at least one stroke before saving.'); return; }
            const record = clone(this.draft); delete record.phase;
            record.label = record.label.trim(); record.updatedAt = new Date().toISOString();
            try {
                const other = this.records.filter(item => item.id !== record.id);
                validateDocument(this.document([...other, record]), this.dataset);
            } catch (error) { this.say(error.message); return; }
            const index = this.records.findIndex(item => item.id === record.id);
            if (index >= 0) this.records[index] = record; else this.records.push(record);
            this.draft = null; this.redo = []; this.selected = record.id; this.view = 'list';
            this.persist(); this.updateInteraction(); this.renderArtwork(); this.render();
        }
        discardDraft() {
            this.draft = null; this.redo = []; this.selected = null; this.view = 'list';
            this.updateInteraction(); this.renderArtwork(); this.render();
        }
        deleteRecord() {
            this.records = this.records.filter(record => record.id !== this.selected);
            this.selected = null; this.view = 'list'; this.persist('Annotation deleted.'); this.renderArtwork(); this.render();
        }
        findRecord(record) {
            const box = bounds(record), camera = this.lime.camera;
            const t = camera.target;
            const rotated = new global.OpenLIME.Transform({ a: t.a });
            const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]].map(point => {
                const p = this.layer.transform.apply(point[0] - this.dataset.width / 2, this.dataset.height / 2 - point[1]);
                return rotated.apply(p.x, p.y);
            });
            const width = Math.max(40, Math.max(...corners.map(p => p.x)) - Math.min(...corners.map(p => p.x)));
            const height = Math.max(40, Math.max(...corners.map(p => p.y)) - Math.min(...corners.map(p => p.y)));
            const viewport = camera.viewport;
            const panelHeight = document.getElementById('viewer-dock').getBoundingClientRect().height + 24;
            const usableHeight = Math.max(viewport.h * 0.3, viewport.h - panelHeight - 24);
            const z = Math.max(camera.minZoom, Math.min(camera.maxZoom, (viewport.w - 48) / width, usableHeight / height));
            const center = this.layer.transform.apply((box.x0 + box.x1) / 2 - this.dataset.width / 2, this.dataset.height / 2 - (box.y0 + box.y1) / 2);
            const p = rotated.apply(center.x, center.y);
            camera.setPosition(300, -p.x * z, -p.y * z + (viewport.h - usableHeight) / 2, z, t.a);
        }

        button(label, action, icon, options = {}) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action;
            button.className = 'annotation-button' + (options.primary ? ' annotation-primary' : '') + (options.active ? ' is-active' : '');
            button.title = label; button.setAttribute('aria-label', label);
            if (options.toggle) button.setAttribute('aria-pressed', String(Boolean(options.active)));
            if (options.id) button.dataset.id = options.id;
            if (icon && this.icons.has(icon)) button.appendChild(this.icons.get(icon).cloneNode(true));
            const text = document.createElement('span'); text.textContent = label;
            if (options.iconOnly && icon && this.icons.has(icon)) text.className = 'annotation-sr-only';
            button.appendChild(text); button.disabled = Boolean(options.disabled);
            return button;
        }
        row(...elements) { const row = document.createElement('div'); row.className = 'annotation-row'; row.append(...elements); return row; }
        paragraph(text, className = 'annotation-hint') { const p = document.createElement('p'); p.className = className; p.textContent = text; return p; }

        render() {
            const scrollTop = this.panel.querySelector('.annotation-body')?.scrollTop || 0;
            this.panel.replaceChildren();
            const content = document.createElement('div'); content.className = 'annotation-content';
            const header = document.createElement('header'); header.className = 'annotation-header';
            if (this.view !== 'list' && (!this.draft || this.view === 'snapshot')) header.appendChild(this.button('Back', 'back', null));
            const heading = document.createElement('h2');
            heading.textContent = ({ list: 'Annotations', draw: this.records.some(r => r.id === this.draft?.id) ? 'Edit drawing' : 'New annotation',
                form: 'Annotation details', detail: 'Annotation', export: 'Download annotations', snapshot: 'Save image', confirm: 'Confirm' })[this.view];
            header.appendChild(heading);
            if (this.view === 'list' && this.dataset) {
                header.append(this.button(this.allVisible ? 'Hide all annotations' : 'Show all annotations', 'visibility-all', this.allVisible ? 'visible' : 'hidden', { iconOnly: true, toggle: true, active: this.allVisible }),
                    this.button('New annotation', 'new', 'add', { iconOnly: true }));
            }
            header.appendChild(this.button('Close panel', 'close', 'close', { iconOnly: true }));
            const body = document.createElement('div'); body.className = 'annotation-body';
            content.append(header, body);
            if (this.fatalError) body.appendChild(this.paragraph(this.fatalError));
            else if (!this.dataset) body.appendChild(this.paragraph('Preparing annotation tools…'));
            else if (this.view === 'list') this.renderList(body);
            else if (this.view === 'draw') this.renderDrawing(body);
            else if (this.view === 'form') this.renderForm(body);
            else if (this.view === 'detail') this.renderDetails(body);
            else if (this.view === 'export') this.renderExport(body);
            else if (this.view === 'snapshot') this.renderSnapshot(body);
            else if (this.view === 'confirm') this.renderConfirm(body);
            const status = this.paragraph(this.notice, 'annotation-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            if (!this.notice) status.hidden = true;
            content.appendChild(status); this.panel.appendChild(content);
            body.scrollTop = scrollTop;
            this.updateInteraction();
        }

        renderList(body) {
            if (!this.records.length) {
                const empty = document.createElement('div'); empty.className = 'annotation-empty';
                empty.append(this.paragraph('Mark what you see.', 'annotation-empty-title'), this.paragraph('Use + to draw on the image, then add a name and description.'));
                body.appendChild(empty);
            }
            const list = document.createElement('div'); list.className = 'annotation-list';
            for (const record of this.records) {
                const item = document.createElement('div'); item.className = 'annotation-item';
                const select = this.button(record.label, 'select', null, { id: record.id, active: this.selected === record.id });
                select.classList.add('annotation-record');
                const dot = document.createElement('span'); dot.className = 'annotation-dot'; dot.style.backgroundColor = record.color;
                select.prepend(dot);
                const summary = document.createElement('small'); summary.textContent = record.description || 'No description'; select.appendChild(summary);
                item.append(select, this.button(record.visible ? 'Hide annotation' : 'Show annotation', 'visibility', record.visible ? 'visible' : 'hidden', { id: record.id, iconOnly: true }));
                list.appendChild(item);
            }
            body.append(list, this.row(this.button('Import JSON', 'import', null), this.button('Download', 'export-all', 'export', { disabled: !this.records.length })));
            body.appendChild(this.paragraph('Saved in this browser. Download JSON to keep a portable copy.'));
        }
        renderDrawing(body) {
            if (!this.draft) return;
            body.appendChild(this.row(this.button('Pen', 'pen', 'draw', { toggle: true, active: this.tool === 'pen' }),
                this.button('Navigate', 'navigate', null, { toggle: true, active: this.tool === 'navigate' }),
                this.button('Undo stroke', 'undo', 'undo', { iconOnly: true, disabled: !this.draft.strokes.length }),
                this.button('Redo stroke', 'redo', 'redo', { iconOnly: true, disabled: !this.redo.length })));
            const palette = document.createElement('div'); palette.className = 'annotation-palette'; palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', 'Drawing color');
            const colorNames = ['Yellow', 'White', 'Blue', 'Pink', 'Green'];
            COLORS.forEach((color, i) => {
                const button = this.button(colorNames[i], 'color', null, { active: this.draft.color === color, toggle: true });
                button.dataset.color = color; button.classList.add('annotation-color'); button.style.setProperty('--swatch', color);
                button.firstChild.className = 'annotation-sr-only'; palette.appendChild(button);
            });
            const widths = this.row(); widths.classList.add('annotation-widths'); widths.setAttribute('aria-label', 'Line thickness');
            [1.5, 2.5, 4].forEach((width, i) => { const button = this.button(['Thin', 'Medium', 'Thick'][i], 'width', null, { active: this.draft.width === width, toggle: true }); button.dataset.width = width; widths.appendChild(button); });
            body.append(this.row(palette, widths), this.paragraph(this.tool === 'pen' ? 'Draw on the image. Switch to Navigate to zoom or pan.' : 'Zoom and pan without drawing. Choose Pen to continue.'),
                this.row(this.button('Cancel', 'cancel-draft', null), this.button('Finish drawing', 'finish', 'ok', { primary: true, disabled: !this.draft.strokes.length })));
        }
        renderForm(body) {
            const form = document.createElement('form'); form.className = 'annotation-form';
            const nameLabel = document.createElement('label'); nameLabel.textContent = 'Name';
            const name = document.createElement('input'); name.name = 'annotation-name'; name.type = 'text'; name.required = true; name.maxLength = 120; name.value = this.draft.label;
            name.autocomplete = 'off'; name.placeholder = 'Give this drawing a name'; nameLabel.appendChild(name);
            const descriptionLabel = document.createElement('label'); descriptionLabel.textContent = 'Description';
            const description = document.createElement('textarea'); description.name = 'annotation-description'; description.rows = 3; description.maxLength = 4000;
            description.value = this.draft.description; description.placeholder = 'What did you notice?'; descriptionLabel.appendChild(description);
            const save = this.button('Save annotation', 'save', 'ok', { primary: true }); save.type = 'submit'; delete save.dataset.action;
            form.append(nameLabel, descriptionLabel, this.row(this.button('Back to drawing', 'draw', 'draw'), save)); body.appendChild(form);
        }
        renderDetails(body) {
            const record = this.records.find(item => item.id === this.selected);
            if (!record) { this.view = 'list'; this.renderList(body); return; }
            body.append(this.paragraph(record.label, 'annotation-detail-title'), this.paragraph(record.description || 'No description.', 'annotation-description'),
                this.row(this.button('Edit', 'edit', 'edit'), this.button('Find in image', 'find', null)),
                this.row(this.button(record.visible ? 'Hide' : 'Show', 'visibility', record.visible ? 'visible' : 'hidden', { id: record.id }),
                    this.button('Download', 'export-one', 'export'), this.button('Delete', 'delete', 'trash')));
        }
        renderExport(body) {
            body.append(this.paragraph(this.exportID ? 'Download the selected annotation.' : 'Download the saved annotations for this image.'),
                this.row(this.button('Editable JSON', 'download-json', null, { primary: true }), this.button('Vector SVG', 'download-svg', null)),
                this.paragraph('JSON keeps names, descriptions and editable drawing data. SVG contains the visible drawing shapes.'));
        }
        renderSnapshot(body) {
            body.append(this.paragraph('Save the current light, rotation and zoom. Menus and editing handles are excluded.'),
                this.row(this.button('RTI only', 'snapshot-plain', null), this.button('With annotations', 'snapshot-annotations', null, { primary: true })),
                this.paragraph('Only saved, visible annotations are included. An unfinished drawing is not exported.'));
        }
        renderConfirm(body) {
            body.append(this.paragraph(this.confirmType === 'delete' ? 'Delete this annotation from this browser?' : 'Discard the unsaved changes to this drawing?'),
                this.row(this.button('Keep', 'confirm-back', null), this.button(this.confirmType === 'delete' ? 'Delete' : 'Discard', 'confirm-yes', 'trash')));
        }

        say(text) { this.notice = text; const status = this.panel.querySelector('.annotation-status'); if (status) { status.textContent = text; status.hidden = false; } }
        onPanelInput(event) {
            if (!this.draft) return;
            if (event.target.name === 'annotation-name') this.draft.label = event.target.value;
            if (event.target.name === 'annotation-description') this.draft.description = event.target.value;
        }
        onPanelClick(event) {
            const button = event.target.closest('button[data-action]');
            if (!button || button.disabled) return;
            const action = button.dataset.action;
            const record = this.records.find(item => item.id === (button.dataset.id || this.selected));
            if (action === 'close') return this.close();
            if (action === 'new') return this.begin();
            if (action === 'select') { this.selected = record.id; this.view = 'detail'; }
            if (action === 'back') { this.selected = null; this.view = this.draft ? this.draft.phase : 'list'; }
            if (action === 'visibility-all') this.allVisible = !this.allVisible;
            if (action === 'visibility' && record) { record.visible = !record.visible; this.persist(record.visible ? 'Annotation shown.' : 'Annotation hidden.'); }
            if (action === 'edit' && record) return this.begin(record);
            if (action === 'find' && record) { this.allVisible = true; record.visible = true; this.persist('Annotation located.'); this.findRecord(record); }
            if (action === 'pen' || action === 'navigate') this.tool = action;
            if (action === 'undo') return this.undoStroke();
            if (action === 'redo') return this.redoStroke();
            if (action === 'color' && this.draft) this.draft.color = button.dataset.color;
            if (action === 'width' && this.draft) this.draft.width = Number(button.dataset.width);
            if (action === 'finish') { this.view = 'form'; this.draft.phase = 'form'; }
            if (action === 'draw') { this.view = 'draw'; this.draft.phase = 'draw'; }
            if (action === 'cancel-draft' || action === 'delete') { this.confirmType = action === 'delete' ? 'delete' : 'discard'; this.confirmBack = this.view; this.view = 'confirm'; }
            if (action === 'confirm-back') this.view = this.confirmBack;
            if (action === 'confirm-yes') return this.confirmType === 'delete' ? this.deleteRecord() : this.discardDraft();
            if (action === 'export-all' || action === 'export-one') { this.exportID = action === 'export-one' ? this.selected : null; this.view = 'export'; }
            if (action === 'download-json') return this.downloadJSON();
            if (action === 'download-svg') return this.downloadSVG();
            if (action === 'snapshot-plain' || action === 'snapshot-annotations') return this.snapshot(action === 'snapshot-annotations');
            if (action === 'import') { this.fileInput.value = ''; this.fileInput.click(); return; }
            this.render(); this.renderArtwork();
            if (action === 'finish') this.panel.querySelector('[name="annotation-name"]')?.focus({ preventScroll: true });
        }

        bindKeyboard() {
            document.addEventListener('keydown', event => {
                const editingText = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
                if (event.key === 'Escape' && this.isOpen) { event.preventDefault(); event.stopImmediatePropagation(); this.close(); return; }
                if (!this.isOpen || !this.draft) return;
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && this.view === 'form') { event.preventDefault(); this.saveDraft(); return; }
                if (editingText) return;
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && this.view === 'draw') {
                    event.preventDefault(); event.stopImmediatePropagation(); if (event.shiftKey) this.redoStroke(); else this.undoStroke();
                }
            }, true);
            document.addEventListener('keyup', event => {
                if (event.ctrlKey || event.metaKey || event.target.closest?.('input,textarea,select,[contenteditable="true"]') || this.stroke) event.stopImmediatePropagation();
            }, true);
            global.addEventListener('beforeunload', event => {
                if (this.draft && (this.draft.strokes.length || this.draft.label || this.draft.description)) { event.preventDefault(); event.returnValue = ''; }
            });
        }

        exportRecords(visibleOnly = false) {
            return this.records.filter(record => this.exportID ? record.id === this.exportID : !visibleOnly || (this.allVisible && record.visible));
        }
        download(blob, filename) {
            const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
            anchor.href = url; anchor.download = filename; anchor.hidden = true;
            document.body.appendChild(anchor); anchor.click(); anchor.remove();
            global.setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        downloadJSON() {
            this.download(new Blob([JSON.stringify(this.document(this.exportRecords()), null, 2)], { type: 'application/json' }), 'rti-annotations.json');
            this.say('JSON download prepared.');
        }
        downloadSVG() {
            const records = this.exportRecords(true);
            if (!records.length) { this.say('No visible annotations to export.'); return; }
            this.download(new Blob([svgDocument(this.dataset, records)], { type: 'image/svg+xml' }), 'rti-annotations.svg');
            this.say('SVG download prepared.');
        }
        async importFile() {
            const file = this.fileInput.files[0]; if (!file) return;
            if (file.size > 5 * 1024 * 1024) { this.say('Choose an annotation JSON file smaller than 5 MB.'); return; }
            try {
                const incoming = validateDocument(JSON.parse(await file.text()), this.dataset);
                const merged = mergeRecords(this.records, incoming);
                this.records = merged.records; this.persist(`${merged.added} annotation${merged.added === 1 ? '' : 's'} imported.`);
                this.allVisible = true; this.view = 'list'; this.selected = null; this.render(); this.renderArtwork();
            } catch (error) { this.say(error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message); }
        }

        openSnapshot() { this.open('snapshot'); }
        async snapshot(includeAnnotations) {
            if (!this.dataset || this.layer.status !== 'ready' || ![...this.layer.tiles.values()].some(tile => tile.missing === 0)) { this.say('Wait for the RTI image to finish loading.'); return; }
            try {
                const time = performance.now();
                this.lime.draw(time);
                const source = this.lime.canvasElement;
                const output = document.createElement('canvas'); output.width = source.width; output.height = source.height;
                const context = output.getContext('2d'); context.drawImage(source, 0, 0);
                const t = this.currentTransforms(time), sx = output.width / t.viewport.w, sy = output.height / t.viewport.h;
                if (includeAnnotations && this.allVisible) {
                    context.save(); context.scale(sx, sy);
                    const corners = [[0, 0], [this.dataset.width, 0], [this.dataset.width, this.dataset.height], [0, this.dataset.height]]
                        .map(point => project(point, t.camera, t.layer, this.dataset, t.viewport));
                    context.beginPath(); corners.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y)); context.closePath(); context.clip();
                    context.lineCap = 'round'; context.lineJoin = 'round';
                    for (const record of this.records.filter(item => item.visible)) for (const stroke of record.strokes) {
                        const points = stroke.points.map(point => project(point, t.camera, t.layer, this.dataset, t.viewport));
                        context.strokeStyle = record.color; context.lineWidth = record.width;
                        context.beginPath(); context.moveTo(...points[0]);
                        if (points.length === 1) context.lineTo(points[0][0] + 0.01, points[0][1]);
                        for (let i = 1; i < points.length - 1; i++) context.quadraticCurveTo(...points[i], (points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2);
                        if (points.length > 1) context.lineTo(...points.at(-1));
                        context.stroke();
                    }
                    context.restore();
                }
                const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
                if (!blob) throw new Error('The image could not be exported.');
                this.download(blob, includeAnnotations ? 'rti-with-annotations.png' : 'rti.png'); this.say('PNG download prepared.');
            } catch (error) { this.say('Image export failed: ' + error.message); }
        }
    }
    global.RTIAnnotations = RTIAnnotations;
})(window);


/* Adapter for the existing multi-dataset pages. No per-page HTML edits required. */
(function (global) {
    'use strict';
    const startViewer = initViewer;
    const engineLoads = new Map();

    function engineReady(url) {
        if (engineLoads.has(url)) return engineLoads.get(url);
        const promise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => global.OpenLIME ? resolve(global.OpenLIME) : reject(new Error('The OpenLIME renderer did not initialise.'));
            script.onerror = () => reject(new Error('Could not load the OpenLIME renderer.'));
            document.head.appendChild(script);
        });
        engineLoads.set(url, promise);
        return promise;
    }

    async function vectorExists(url) {
        try {
            let response = await fetch(url, { method: 'HEAD' });
            if (response.status === 405 || response.status === 501) {
                response = await fetch(url, { headers: { Range: 'bytes=0-31' } });
                response.body?.cancel?.().catch(() => {});
            }
            if (!response.ok) return false;
            const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
            return !type || type.startsWith('image/') || type === 'application/octet-stream';
        } catch (_) {
            return false;
        }
    }

    function applyInitialRotation(result, angle) {
        if (!Number.isFinite(angle) || angle % 360 === 0) return;
        let applied = false;
        const rotateOnce = () => {
            const { lime, baseLayer } = result;
            const camera = lime.camera;
            if (applied || baseLayer.status !== 'ready' || !camera.viewport || !(baseLayer.layout.width > 0 && baseLayer.layout.height > 0) || camera.boundingBox.isEmpty()) return;
            applied = true;
            camera.rotate(0, angle);
            const a = camera.target.a;
            const rotated = new global.OpenLIME.Transform({ a }).transformBox(camera.boundingBox);
            const center = rotated.center();
            const z = Math.min(camera.viewport.dx / rotated.width(), camera.viewport.dy / rotated.height());
            camera.setPosition(0, -center.x * z, -center.y * z, z, a);
        };
        // Core initial fit was registered first; this runs after it, only once.
        result.lime.canvas.addEvent('updateSize', rotateOnce);
        result.baseLayer.addEvent('ready', rotateOnce);
        result.baseLayer.addEvent('loaded', rotateOnce);
        rotateOnce();
    }

    function showLoadError(error) {
        let status = document.getElementById('viewer-status');
        if (!status) {
            status = document.createElement('div'); status.id = 'viewer-status';
            document.getElementById('demo')?.appendChild(status);
        }
        status.hidden = false; status.setAttribute('role', 'alert');
        status.textContent = error.message || 'The RTI viewer could not be loaded.';
    }

    global.initViewer = function initDatasetViewer(config = {}) {
        const asset = name => new URL(name, DATASET_ASSETS_BASE).href;
        const has = name => Object.prototype.hasOwnProperty.call(config, name);
        const options = {
            stylesheetUrl: asset('skin.css'), skinUrl: asset('skin.svg'), rtiUrl: 'info.json',
            vectorUrl: 'vector.png', lightActive: true, ...config,
            iconVisible: has('iconVisible') ? config.iconVisible : DATASET_VIEWER_OPTIONS.iconVisible,
            iconUrl: has('iconUrl') ? config.iconUrl : asset(DATASET_VIEWER_OPTIONS.iconUrl),
            iconHref: has('iconHref') ? config.iconHref : DATASET_VIEWER_OPTIONS.iconHref,
            iconAlt: has('iconAlt') ? config.iconAlt : DATASET_VIEWER_OPTIONS.iconAlt
        };
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport && !viewport.content.includes('viewport-fit')) viewport.content += ', viewport-fit=cover';
        const rotation = options.rotate;
        // The adapter applies initial rotation after the core's first valid fit.
        options.rotate = 0;
        const renderer = new URL(config.openlimeUrl || asset('openlime.min.js'), document.baseURI).href;
        const vector = options.vectorUrl ? new URL(options.vectorUrl, document.baseURI).href : null;
        const prepared = Promise.all([engineReady(renderer), vector ? vectorExists(vector) : false]);
        const ready = prepared.then(async ([, available]) => {
            if (!available) options.vectorUrl = null;
            const result = await startViewer(options);
            applyInitialRotation(result, rotation);
            return result;
        }).catch(error => { showLoadError(error); throw error; });
        global.viewerReady = ready;
        return ready;
    };
})(window);
