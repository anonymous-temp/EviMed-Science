package com.evimed.agent.evidence.agentevidencebased.infrastructure.util;

import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestTemplate;

/**
 * 远程调用翻译
 * 原项目通过 FineScreenFeign 调用，新项目改为 RestTemplate 直调。
 * 翻译接口：POST /FineScreenController/deepl，请求体 {"word":"..."}，响应为翻译后的字符串。
 */
@Slf4j
public class TransUtils {

    /**
     * fine-screen 服务的翻译接口地址（内网）。
     * 如未部署翻译服务，trans() 会降级返回空字符串，调用方已有空字符串分支处理。
     */
    private static final String DEEPL_URL =
            "http://fine-screen/FineScreenController/deepl";

    private static final RestTemplate REST_TEMPLATE;

    static {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(5000);
        factory.setReadTimeout(10000);
        REST_TEMPLATE = new RestTemplate(factory);
    }

    /**
     * 将中文词翻译为英文（调用内网 fine-screen/deepl 接口）。
     * 若接口不可达或发生异常，降级返回空字符串。
     */
    public static String trans(String word) {
        try {
            JSONObject body = new JSONObject();
            body.put("word", word);

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);

            ResponseEntity<String> response = REST_TEMPLATE.postForEntity(
                    DEEPL_URL,
                    new HttpEntity<>(body.toJSONString(), headers),
                    String.class);

            if (response.getStatusCode().is2xxSuccessful() && response.getBody() != null) {
                return response.getBody();
            }
            log.warn("翻译接口返回异常状态: {}", response.getStatusCode());
            return "";
        } catch (Exception e) {
            log.warn("翻译接口调用失败，降级返回空字符串: {}", e.getMessage());
            return "";
        }
    }

    public static boolean judgeChinese(String str) {
        str = str.replaceAll("[^a-zA-Z0-9\\u4e00-\\u9fa5]", " ");
        return str.getBytes().length != str.length();
    }
}
