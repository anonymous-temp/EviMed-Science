package com.sentum.evidencecomprehensive.feign;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.dto.feign.OutlineDTO;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;
import java.util.Map;

@Component
@FeignClient(name = "sentum-evimed-drug")
public interface DrugFeign {
    @GetMapping("/drug-api/instructions/text")
    JSONObject getText(@RequestParam("source") String source,@RequestParam("pdfName")String pdfName);
}
