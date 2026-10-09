package org.example.minizine;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import tools.jackson.databind.ObjectMapper;

/**
 * Stores zines on disk: one folder per zine holding {@code zine.json} (page metadata)
 * and one image file per filled page.
 */
@Service
public class ZineStore {

    /**
     * How a picture sits in its box. {@code fill}: cover the whole box (trimming a little off the
     * edges); otherwise the whole picture shows. The page decides which, based on the picture's shape.
     */
    public record Layout(int rotation, boolean fill) {
        public static final Layout WHOLE = new Layout(0, false);

        public Layout {
            rotation = Math.floorMod(rotation, 360);
        }
    }

    public record Page(String contentType, long version, Layout layout) {
        public Page {
            layout = layout == null ? Layout.WHOLE : layout;
        }
    }

    public record Zine(Map<Slot, Page> pages) {
    }

    private final Path root;
    private final ObjectMapper mapper;

    public ZineStore(@Value("${minizine.data-dir:zine-data}") Path root, ObjectMapper mapper) {
        this.root = root;
        this.mapper = mapper;
    }

    public synchronized UUID create() {
        UUID id = UUID.randomUUID();
        try {
            Files.createDirectories(dir(id));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        write(id, new Zine(new EnumMap<>(Slot.class)));
        return id;
    }

    public synchronized Optional<Zine> find(UUID id) {
        Path file = dir(id).resolve("zine.json");
        if (!Files.exists(file)) {
            return Optional.empty();
        }
        try {
            Zine zine = mapper.readValue(Files.readString(file), Zine.class);
            return Optional.of(new Zine(new EnumMap<>(zine.pages())));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public synchronized Optional<Zine> saveImage(UUID id, Slot slot, byte[] data, String contentType, Layout layout) {
        return find(id).map(zine -> {
            try {
                Path tmp = Files.createTempFile(dir(id), slot.slug(), ".tmp");
                Files.write(tmp, data);
                Files.move(tmp, imageFile(id, slot), StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            Page old = zine.pages().get(slot);
            zine.pages().put(slot, new Page(contentType, old == null ? 1 : old.version() + 1, layout));
            write(id, zine);
            return zine;
        });
    }

    public synchronized Optional<Zine> setLayout(UUID id, Slot slot, Layout layout) {
        return find(id).filter(zine -> zine.pages().containsKey(slot)).map(zine -> {
            Page page = zine.pages().get(slot);
            zine.pages().put(slot, new Page(page.contentType(), page.version(), layout));
            write(id, zine);
            return zine;
        });
    }

    public synchronized Optional<Zine> remove(UUID id, Slot slot) {
        return find(id).map(zine -> {
            try {
                Files.deleteIfExists(imageFile(id, slot));
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            zine.pages().remove(slot);
            write(id, zine);
            return zine;
        });
    }

    public synchronized Optional<byte[]> loadImage(UUID id, Slot slot) {
        Path file = imageFile(id, slot);
        if (!Files.exists(file)) {
            return Optional.empty();
        }
        try {
            return Optional.of(Files.readAllBytes(file));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private void write(UUID id, Zine zine) {
        try {
            Files.writeString(dir(id).resolve("zine.json"), mapper.writeValueAsString(zine));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // Ids and slots are parsed into UUID / enum before they get here, so paths cannot escape the root.
    private Path dir(UUID id) {
        return root.resolve(id.toString());
    }

    private Path imageFile(UUID id, Slot slot) {
        return dir(id).resolve(slot.slug() + ".img");
    }
}
