(() => {
    'use strict';

    // Phone photos are often 12+ megapixels. Shrinking them before upload makes uploads fast
    // on school wifi and is still plenty for a printed panel (~7 x 10 cm).
    const MAX_SIDE = 2000;
    const STORAGE_KEY = 'minizine.lastId';
    // Width / height of one page on the sheet (A4 landscape split 4 x 2 = 74.25 x 105 mm).
    const PAGE_ASPECT = 74.25 / 105;
    // Fill the page when that trims at most ~13% of the picture. An iPad/iPhone photo taken upright
    // (3:4) only loses ~6%, so it fills; wide photos and screenshots keep showing the whole picture.
    const MAX_FILL_SCALE = 1.15;

    const sheet = document.getElementById('sheet');
    const toolbar = document.getElementById('toolbar');
    const toolbarLabel = document.getElementById('toolbarLabel');
    const fileInput = document.getElementById('fileInput');
    const toast = document.getElementById('toast');
    const flipTop = document.getElementById('flipTop');
    const panels = new Map([...sheet.querySelectorAll('.panel')].map(p => [p.dataset.slot, p]));

    let zineId = null;
    let pages = {};          // slot -> { imageUrl, rotation, fill }
    let selected = null;     // slot shown in the toolbar
    let uploadTarget = null; // slot the file picker is choosing for
    const busy = new Set();
    const sizes = new Map(); // imageUrl -> { w, h } once the picture has loaded

    // ---------- API ----------

    async function api(path, options = {}) {
        const res = await fetch('/api/zines' + path, options);
        if (!res.ok) {
            const err = new Error('HTTP ' + res.status);
            err.status = res.status;
            throw err;
        }
        return res.json();
    }

    async function loadZine() {
        const fromUrl = new URLSearchParams(location.search).get('z');
        const candidates = [fromUrl, safeGet(STORAGE_KEY)].filter(Boolean);
        for (const id of candidates) {
            try {
                return await api('/' + encodeURIComponent(id));
            } catch (e) {
                if (e.status !== 404) throw e;
            }
        }
        return api('', {method: 'POST'});
    }

    function useZine(zine) {
        zineId = zine.id;
        pages = zine.pages;
        safeSet(STORAGE_KEY, zineId);
        const url = new URL(location.href);
        url.searchParams.set('z', zineId);
        history.replaceState(null, '', url);
        render();
    }

    // ---------- Fill or whole picture ----------

    function isSideways(rotation) {
        return ((rotation % 180) + 180) % 180 === 90;
    }

    /** True when the picture is close enough to the page's shape to fill it without losing much. */
    function shouldFill(width, height, rotation) {
        if (!width || !height) return false;
        const aspect = isSideways(rotation) ? height / width : width / height;
        const scale = aspect > PAGE_ASPECT ? aspect / PAGE_ASPECT : PAGE_ASPECT / aspect;
        return scale <= MAX_FILL_SCALE;
    }

    // ---------- Rendering ----------

    function render() {
        for (const [slot, panel] of panels) {
            const page = pages[slot];
            const frame = document.createElement('div');
            frame.className = 'frame';

            if (page) {
                const img = document.createElement('img');
                img.alt = panel.dataset.label;
                img.draggable = false;
                img.addEventListener('load', () =>
                    sizes.set(page.imageUrl, {w: img.naturalWidth, h: img.naturalHeight}));
                img.src = page.imageUrl;
                applyLayout(img, page);
                frame.append(img);
            } else {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.innerHTML = '<span class="plus">+</span><span class="label"></span><span class="tap">Tryck för att lägga till bild</span>';
                empty.querySelector('.label').textContent = panel.dataset.label;
                frame.append(empty);
            }

            if (busy.has(slot)) {
                const b = document.createElement('div');
                b.className = 'busy';
                b.textContent = 'Laddar upp…';
                frame.append(b);
            }

            panel.replaceChildren(frame);
            panel.classList.toggle('selected', slot === selected);
        }

        if (selected && pages[selected]) {
            toolbarLabel.textContent = panels.get(selected).dataset.label;
            toolbar.hidden = false;
        } else {
            selected = null;
            toolbar.hidden = true;
        }
    }

    function applyLayout(img, page) {
        // Rotation keeps growing (90, 180, 270, 360, ...) on screen so the animation always turns
        // the short way; only the remainder matters for the shape of the box.
        img.style.setProperty('--rotation', page.rotation + 'deg');
        img.classList.toggle('sideways', isSideways(page.rotation));
        img.classList.toggle('fill', page.fill === true);
    }

    // ---------- Actions ----------

    sheet.addEventListener('click', e => {
        const panel = e.target.closest('.panel');
        if (!panel || busy.has(panel.dataset.slot)) return;
        const slot = panel.dataset.slot;
        if (pages[slot]) {
            selected = selected === slot ? null : slot;
            render();
        } else {
            pickFile(slot);
        }
    });

    toolbar.addEventListener('click', e => {
        const action = e.target.closest('button')?.dataset.action;
        if (!action || !selected) return;
        switch (action) {
            case 'rotate-left': return rotate(selected, -90);
            case 'rotate-right': return rotate(selected, 90);
            case 'replace': return pickFile(selected);
            case 'remove': return remove(selected);
            case 'close':
                selected = null;
                return render();
        }
    });

    function pickFile(slot) {
        uploadTarget = slot;
        fileInput.value = '';
        fileInput.click();
    }

    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file && uploadTarget) upload(uploadTarget, file);
    });

    async function upload(slot, file) {
        busy.add(slot);
        render();
        try {
            const {blob, width, height} = await shrink(file);
            const form = new FormData();
            form.append('file', blob, 'image.jpg');
            form.append('fill', String(shouldFill(width, height, 0)));
            const zine = await api(`/${zineId}/pages/${slot}/image`, {method: 'POST', body: form});
            pages = zine.pages;
            selected = null;
        } catch (e) {
            console.error(e);
            showToast(e.status === 415
                ? 'Den bildtypen går inte att använda. Prova en JPG- eller PNG-bild.'
                : 'Bilden kunde inte laddas upp. Försök igen.');
        } finally {
            busy.delete(slot);
            render();
        }
    }

    async function rotate(slot, delta) {
        const page = pages[slot];
        page.rotation += delta;
        // A turned picture has a new shape on the page, so decide again whether it should fill.
        const size = sizes.get(page.imageUrl);
        if (size) page.fill = shouldFill(size.w, size.h, page.rotation);
        // Update in place without rebuilding the panel so the turn animates smoothly.
        const img = panels.get(slot).querySelector('img');
        if (img) applyLayout(img, page);
        try {
            await api(`/${zineId}/pages/${slot}/layout`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({rotation: ((page.rotation % 360) + 360) % 360, fill: page.fill})
            });
        } catch (e) {
            console.error(e);
            showToast('Kunde inte spara rotationen.');
        }
    }

    async function remove(slot) {
        if (!confirm('Ta bort bilden från ' + panels.get(slot).dataset.label + '?')) return;
        try {
            const zine = await api(`/${zineId}/pages/${slot}`, {method: 'DELETE'});
            pages = zine.pages;
            selected = null;
            render();
        } catch (e) {
            console.error(e);
            showToast('Kunde inte ta bort bilden.');
        }
    }

    /**
     * Downscale the photo and re-encode it as JPEG. Drawing the decoded <img> onto a canvas also
     * bakes in the camera's EXIF orientation, so photos taken holding the phone sideways come out
     * the right way up before the kid ever needs the rotate buttons.
     * Returns the blob to upload and the picture's size (0 if the browser cannot read it).
     */
    async function shrink(file) {
        let img;
        const url = URL.createObjectURL(file);
        try {
            img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = reject;
                i.src = url;
            });
        } catch {
            // The browser cannot decode it (e.g. HEIC on a PC); let the server decide.
            URL.revokeObjectURL(url);
            return {blob: file, width: 0, height: 0};
        }
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black as JPEG
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        return {blob: blob || file, width: canvas.width, height: canvas.height};
    }

    // ---------- Top bar ----------

    document.getElementById('printBtn').addEventListener('click', () => {
        selected = null;
        render();
        window.print();
    });

    document.getElementById('shareBtn').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            showToast('Länken är kopierad! Öppna den på en annan enhet för att fortsätta.');
        } catch {
            prompt('Kopiera länken:', location.href);
        }
    });

    document.getElementById('newBtn').addEventListener('click', async () => {
        if (!confirm('Starta en ny, tom zine? Den gamla finns kvar på sin länk.')) return;
        selected = null;
        useZine(await api('', {method: 'POST'}));
    });

    const applyFlip = () => sheet.classList.toggle('flip-top', flipTop.checked);
    flipTop.addEventListener('change', applyFlip);
    applyFlip();

    // ---------- Helpers ----------

    let toastTimer;
    function showToast(message) {
        toast.textContent = message;
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.hidden = true, 3500);
    }

    function safeGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    function safeSet(key, value) {
        try { localStorage.setItem(key, value); } catch { /* private mode: link still works */ }
    }

    loadZine().then(useZine).catch(e => {
        console.error(e);
        showToast('Kunde inte nå servern.');
    });
})();
