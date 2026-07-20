package com.sentum.evidencecomprehensive.feign;

import com.sentum.evidencecomprehensive.domain.vo.req.EditMultiContentRequest;
import feign.Headers;
import feign.Response;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;

@Component
@FeignClient(name = "pharmacy-rag")
public interface PharmacyFeign {
    
    @GetMapping("/pharmacy-rag-api/prompt/reportTemplate-ai")
    String reportTemplateAI(@RequestParam("id") String id);
    
    @GetMapping("/pharmacy-rag-api/prompt/fillTemplate")
    @Headers("Accept: text/event-stream" )
    Response fillTemplate(@RequestParam("id") String id, @RequestParam("medicine") String medicine, @RequestParam("disease") String disease, @RequestParam("userId") Long userId, @RequestParam("requestId") String requestId);

    @PostMapping("/pharmacy-rag-api/prompt/edit/multi")
    @Headers("Accept: text/event-stream" )
    Response edit(@RequestBody EditMultiContentRequest editMultiContentRequest);

}
