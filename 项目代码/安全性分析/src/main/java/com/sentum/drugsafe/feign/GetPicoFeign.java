package com.sentum.drugsafe.feign;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

/**
 * 从通用检索与检索式检索中提取pico
 */
@Component
@FeignClient(name = "GETPICO")
public interface GetPicoFeign {
    @GetMapping("/web-service")
    String getPico(@RequestParam("valid_word") String validWord);
}
