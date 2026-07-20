package com.sentum.feign;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;

/**
 * 解析英文检索条件
 */
@Component
@FeignClient(name = "parsing-phrase")
public interface ParingPhraseFeign {
    @GetMapping("/analysisController/parsingPhrase")
    List<String> parsingPhrase(@RequestParam("text") String text);

}
