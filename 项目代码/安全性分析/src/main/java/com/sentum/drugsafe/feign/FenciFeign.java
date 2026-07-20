package com.sentum.drugsafe.feign;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;

@FeignClient("sentum-evimed-fenci")
public interface FenciFeign {
    @GetMapping("/fenci-api/jieba")
    List<String> jieba(@RequestParam("words") String words);
}
