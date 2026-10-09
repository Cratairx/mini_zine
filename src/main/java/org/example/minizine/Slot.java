package org.example.minizine;

import java.util.Arrays;
import java.util.Optional;

/**
 * The eight panels of a one-sheet mini zine, as laid out on A4 landscape:
 * <pre>
 *   PAGE 6     | PAGE 5      | PAGE 4 | PAGE 3      (top row, printed upside down)
 *   BACK COVER | FRONT COVER | PAGE 1 | PAGE 2
 * </pre>
 */
public enum Slot {
    PAGE_6, PAGE_5, PAGE_4, PAGE_3,
    BACK_COVER, FRONT_COVER, PAGE_1, PAGE_2;

    /** URL-friendly name, e.g. {@code front-cover}. */
    public String slug() {
        return name().toLowerCase().replace('_', '-');
    }

    public static Optional<Slot> fromSlug(String slug) {
        return Arrays.stream(values()).filter(s -> s.slug().equals(slug)).findFirst();
    }
}
