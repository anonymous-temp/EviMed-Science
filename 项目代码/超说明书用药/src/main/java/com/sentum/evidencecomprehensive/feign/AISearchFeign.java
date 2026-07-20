package com.sentum.evidencecomprehensive.feign;

import feign.Headers;
import feign.Response;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Component
@FeignClient(name = "sentum-evimed-ai-search")
public interface AISearchFeign {
    @GetMapping("/ai-search/stream")
    @Headers("Accept: text/event-stream")
    Response stream(@RequestParam(name = "question") String question, @RequestParam(name = "startYear")  Integer startYear, @RequestParam(name = "endYear")  Integer endYear);
}
