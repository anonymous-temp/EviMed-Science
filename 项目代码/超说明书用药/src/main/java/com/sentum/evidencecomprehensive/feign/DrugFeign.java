package com.sentum.evidencecomprehensive.feign;

import com.alibaba.fastjson.JSONObject;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Component
@FeignClient(name = "sentum-evimed-drug")
public interface DrugFeign {
    @GetMapping("/drug-api/instructions/text")
    JSONObject getText(@RequestParam("source") String source,@RequestParam("pdfName")String pdfName);
}
