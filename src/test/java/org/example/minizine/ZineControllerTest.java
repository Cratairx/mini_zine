package org.example.minizine;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.file.Path;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import com.jayway.jsonpath.JsonPath;

@SpringBootTest
@AutoConfigureMockMvc
class ZineControllerTest {

    @TempDir
    static Path dataDir;

    @DynamicPropertySource
    static void dataDir(DynamicPropertyRegistry registry) {
        registry.add("minizine.data-dir", () -> dataDir.toString());
    }

    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0};

    @Autowired
    MockMvc mvc;

    @Test
    void uploadRotateAndRemove() throws Exception {
        String id = JsonPath.read(mvc.perform(post("/api/zines"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(), "$.id");

        mvc.perform(multipart("/api/zines/" + id + "/pages/front-cover/image")
                        .file(new MockMultipartFile("file", "x.png", "image/png", PNG)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pages.front-cover.rotation").value(0))
                .andExpect(jsonPath("$.pages.front-cover.fill").value(false));

        mvc.perform(multipart("/api/zines/" + id + "/pages/page-1/image")
                        .file(new MockMultipartFile("file", "x.png", "image/png", PNG))
                        .param("fill", "true"))
                .andExpect(jsonPath("$.pages.page-1.fill").value(true));

        mvc.perform(put("/api/zines/" + id + "/pages/front-cover/layout")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"rotation\": -90, \"fill\": true}"))
                .andExpect(status().isOk());

        mvc.perform(get("/api/zines/" + id))
                .andExpect(jsonPath("$.pages.front-cover.rotation").value(270))
                .andExpect(jsonPath("$.pages.front-cover.fill").value(true));

        mvc.perform(put("/api/zines/" + id + "/pages/front-cover/layout")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"rotation\": 45, \"fill\": false}"))
                .andExpect(status().isBadRequest());

        mvc.perform(get("/api/zines/" + id + "/pages/front-cover/image"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.IMAGE_PNG))
                .andExpect(content().bytes(PNG));

        mvc.perform(delete("/api/zines/" + id + "/pages/front-cover"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.pages.front-cover").doesNotExist());
    }

    @Test
    void rejectsNonImagesAndUnknownSlots() throws Exception {
        String id = JsonPath.read(mvc.perform(post("/api/zines"))
                .andReturn().getResponse().getContentAsString(), "$.id");

        mvc.perform(multipart("/api/zines/" + id + "/pages/page-1/image")
                        .file(new MockMultipartFile("file", "x.png", "image/png", "<script>".getBytes())))
                .andExpect(status().isUnsupportedMediaType());

        mvc.perform(multipart("/api/zines/" + id + "/pages/../../etc/image")
                        .file(new MockMultipartFile("file", "x.png", "image/png", PNG)))
                .andExpect(status().is4xxClientError());

        mvc.perform(get("/api/zines/not-a-uuid")).andExpect(status().isNotFound());
    }
}
