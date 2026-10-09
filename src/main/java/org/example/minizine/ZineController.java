package org.example.minizine;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/zines")
public class ZineController {

    public record PageView(String imageUrl, int rotation, boolean fill) {
    }

    public record ZineView(String id, Map<String, PageView> pages) {
    }

    public record LayoutRequest(int rotation, boolean fill) {
    }

    private final ZineStore store;

    public ZineController(ZineStore store) {
        this.store = store;
    }

    @PostMapping
    public ZineView create() {
        UUID id = store.create();
        return view(id, store.find(id).orElseThrow());
    }

    @GetMapping("/{id}")
    public ZineView get(@PathVariable String id) {
        UUID zineId = parseId(id);
        return view(zineId, store.find(zineId).orElseThrow(ZineController::notFound));
    }

    @PostMapping(path = "/{id}/pages/{slot}/image", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ZineView upload(@PathVariable String id, @PathVariable String slot,
                           @RequestParam("file") MultipartFile file,
                           @RequestParam(defaultValue = "false") boolean fill) throws IOException {
        UUID zineId = parseId(id);
        Slot s = parseSlot(slot);
        byte[] data = file.getBytes();
        String contentType = detectImageType(data);
        return view(zineId, store.saveImage(zineId, s, data, contentType, new ZineStore.Layout(0, fill))
                .orElseThrow(ZineController::notFound));
    }

    @PutMapping("/{id}/pages/{slot}/layout")
    public ZineView layout(@PathVariable String id, @PathVariable String slot, @RequestBody LayoutRequest body) {
        if (body.rotation() % 90 != 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Rotation must be a multiple of 90");
        }
        UUID zineId = parseId(id);
        ZineStore.Layout layout = new ZineStore.Layout(body.rotation(), body.fill());
        return view(zineId, store.setLayout(zineId, parseSlot(slot), layout).orElseThrow(ZineController::notFound));
    }

    @DeleteMapping("/{id}/pages/{slot}")
    public ZineView remove(@PathVariable String id, @PathVariable String slot) {
        UUID zineId = parseId(id);
        return view(zineId, store.remove(zineId, parseSlot(slot)).orElseThrow(ZineController::notFound));
    }

    @GetMapping("/{id}/pages/{slot}/image")
    public ResponseEntity<byte[]> image(@PathVariable String id, @PathVariable String slot) {
        UUID zineId = parseId(id);
        Slot s = parseSlot(slot);
        ZineStore.Page page = store.find(zineId).map(z -> z.pages().get(s)).orElseThrow(ZineController::notFound);
        byte[] data = store.loadImage(zineId, s).orElseThrow(ZineController::notFound);
        // The URL carries a version number, so a new upload always gets a fresh URL and caching is safe.
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(page.contentType()))
                .cacheControl(CacheControl.maxAge(365, TimeUnit.DAYS))
                .body(data);
    }

    private static ZineView view(UUID id, ZineStore.Zine zine) {
        Map<String, PageView> pages = new LinkedHashMap<>();
        zine.pages().forEach((slot, page) -> {
            ZineStore.Layout l = page.layout();
            pages.put(slot.slug(), new PageView(
                    "/api/zines/" + id + "/pages/" + slot.slug() + "/image?v=" + page.version(),
                    l.rotation(), l.fill()));
        });
        return new ZineView(id.toString(), pages);
    }

    /** Trust the file's bytes, not its name or the type the browser claims. */
    static String detectImageType(byte[] d) {
        if (d.length > 3 && (d[0] & 0xFF) == 0xFF && (d[1] & 0xFF) == 0xD8 && (d[2] & 0xFF) == 0xFF) {
            return MediaType.IMAGE_JPEG_VALUE;
        }
        if (d.length > 8 && (d[0] & 0xFF) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G') {
            return MediaType.IMAGE_PNG_VALUE;
        }
        if (d.length > 12 && d[0] == 'R' && d[1] == 'I' && d[2] == 'F' && d[3] == 'F'
                && d[8] == 'W' && d[9] == 'E' && d[10] == 'B' && d[11] == 'P') {
            return "image/webp";
        }
        if (d.length > 6 && d[0] == 'G' && d[1] == 'I' && d[2] == 'F' && d[3] == '8') {
            return MediaType.IMAGE_GIF_VALUE;
        }
        throw new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Only JPEG, PNG, WebP or GIF images");
    }

    private static UUID parseId(String id) {
        try {
            return UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            throw notFound();
        }
    }

    private static Slot parseSlot(String slot) {
        return Slot.fromSlug(slot).orElseThrow(ZineController::notFound);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND);
    }
}
