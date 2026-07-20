package com.sentum.feign;

import com.alibaba.fastjson.JSONObject;
import com.google.gson.JsonObject;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;

/**
 * 检索中心
 * @author zgm
 */
@Component
@FeignClient("sentum-evimed-evidence-comprehensive")
public interface EvidenceFeign {
    @PostMapping("/evidence-api/retrieval-api/large-retrieval")
    String retrieval(@RequestBody MultiValueMap<String,String> map);


    @PostMapping("/evidence-api/retrieval-api/vector-retrieval")
    List<String> vectorRetrieval(@RequestBody JSONObject object);
}
