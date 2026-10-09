(() => {
    'use strict';

    // Phone photos are often 12+ megapixels. Shrinking them keeps the browser storage small
    // and is still plenty for a printed panel (~7 x 10 cm).
    const MAX_SIDE = 2000;
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

    // slot -> { blob, width, height, rotation, fill, url }   (url: object URL for showing the blob)
    let pages = {};
    let selected = null;     // slot shown in the toolbar
    let uploadTarget = null; // slot the file picker is choosing for
    const busy = new Set();

    // ---------- Storage: the pictures live in this browser only (IndexedDB) ----------

    const store = (() => {
        const NAME = 'pages';
        let dbPromise = null;

        function open() {
            dbPromise ??= new Promise((resolve, reject) => {
                const req = indexedDB.open('minizine', 1);
                req.onupgradeneeded = () => req.result.createObjectStore(NAME);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return dbPromise;
        }

        async function run(mode, work) {
            const db = await open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(NAME, mode);
                const result = work(tx.objectStore(NAME));
                tx.oncomplete = () => resolve(result?.result);
                tx.onerror = () => reject(tx.error ?? new Error('IndexedDB error'));
                tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'));
            });
        }

        return {
            async loadAll() {
                const db = await open();
                return new Promise((resolve, reject) => {
                    const all = {};
                    const req = db.transaction(NAME).objectStore(NAME).openCursor();
                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) return resolve(all);
                        all[cursor.key] = cursor.value;
                        cursor.continue();
                    };
                    req.onerror = () => reject(req.error);
                });
            },
            save: (slot, page) => run('readwrite', s => s.put(page, slot)),
            remove: slot => run('readwrite', s => s.delete(slot)),
            clear: () => run('readwrite', s => s.clear())
        };
    })();

    /**
     * What goes into storage. The picture is stored as plain bytes, not a Blob: some Safari
     * versions cannot put Blobs in IndexedDB.
     */
    async function stored(page) {
        const {blob, width, height, rotation, fill} = page;
        return {bytes: await blob.arrayBuffer(), type: blob.type, width, height, rotation, fill};
    }

    function fromStored(record) {
        const {bytes, type, width, height, rotation, fill} = record;
        return {blob: new Blob([bytes], {type}), width, height, rotation, fill};
    }

    function setPage(slot, page) {
        if (pages[slot]?.url) URL.revokeObjectURL(pages[slot].url);
        if (page) {
            page.url = URL.createObjectURL(page.blob);
            pages[slot] = page;
        } else {
            delete pages[slot];
        }
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
                img.src = page.url;
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
                b.textContent = 'Laddar…';
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
        if (file && uploadTarget) addPicture(uploadTarget, file);
    });

    async function addPicture(slot, file) {
        busy.add(slot);
        render();
        try {
            const {blob, width, height} = await shrink(file);
            const page = {blob, width, height, rotation: 0, fill: shouldFill(width, height, 0)};
            setPage(slot, page);
            selected = null;
            try {
                await store.save(slot, await stored(page));
            } catch (e) {
                // Still show the picture; it just will not be there after the page is closed.
                console.error(e);
                showToast(e?.name === 'QuotaExceededError'
                    ? 'Enheten är full, bilden sparas inte till nästa gång.'
                    : 'Bilden kunde inte sparas till nästa gång.');
            }
        } catch (e) {
            console.error(e);
            showToast('Den bilden gick inte att använda. Prova en annan bild (JPG eller PNG).');
        } finally {
            busy.delete(slot);
            render();
        }
    }

    async function rotate(slot, delta) {
        const page = pages[slot];
        page.rotation += delta;
        // A turned picture has a new shape on the page, so decide again whether it should fill.
        page.fill = shouldFill(page.width, page.height, page.rotation);
        // Update in place without rebuilding the panel so the turn animates smoothly.
        const img = panels.get(slot).querySelector('img');
        if (img) applyLayout(img, page);
        try {
            await store.save(slot, {...await stored(page), rotation: ((page.rotation % 360) + 360) % 360});
        } catch (e) {
            console.error(e);
            showToast('Kunde inte spara rotationen.');
        }
    }

    async function remove(slot) {
        if (!confirm('Ta bort bilden från ' + panels.get(slot).dataset.label + '?')) return;
        try {
            await store.remove(slot);
            setPage(slot, null);
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
     * Throws if the browser cannot read the picture (e.g. HEIC on a PC).
     */
    async function shrink(file) {
        const url = URL.createObjectURL(file);
        try {
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = () => reject(new Error('Cannot decode image'));
                i.src = url;
            });
            const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.naturalWidth * scale);
            canvas.height = Math.round(img.naturalHeight * scale);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black as JPEG
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
            if (!blob) throw new Error('Cannot encode image');
            return {blob, width: canvas.width, height: canvas.height};
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // ---------- Top bar ----------

    document.getElementById('printBtn').addEventListener('click', () => {
        selected = null;
        render();
        window.print();
    });

    document.getElementById('newBtn').addEventListener('click', async () => {
        if (!confirm('Starta en ny, tom zine? Alla bilder i den här zinen tas bort.')) return;
        try {
            await store.clear();
            for (const slot of Object.keys(pages)) setPage(slot, null);
            selected = null;
            render();
        } catch (e) {
            console.error(e);
            showToast('Kunde inte rensa zinen.');
        }
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

    // ---------- Start ----------

    render();
    // Ask the browser not to clear the pictures when the device runs low on space.
    navigator.storage?.persist?.().catch(() => {});
    store.loadAll()
        .then(saved => {
            for (const [slot, record] of Object.entries(saved)) {
                if (panels.has(slot) && record?.bytes) setPage(slot, fromStored(record));
            }
            render();
        })
        .catch(e => {
            console.error(e);
            showToast('Bilderna kan inte sparas i den här webbläsaren (privat läge?). De försvinner när sidan stängs.');
        });
})();
