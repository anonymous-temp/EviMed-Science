package com.sentum.drugsafe.feign;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.pojo.ScreenRequest;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;

@Component
@FeignClient("fine-screen")
public interface FineScreenFeign {
    @GetMapping("/FineScreenController/jieBaParticiple")
    List<String> jieBaParticiple(@RequestParam("text") String text);

    @GetMapping("/FineScreenController/getSynonyms")
    JSONObject getSynonyms(@RequestParam("word") String word);

    @PostMapping("/FineScreenController/screen")
    JSONObject screen(@RequestBody ScreenRequest screenRequest);

    @PostMapping("/FineScreenController/deepl")
    String deepl(@RequestBody JSONObject jsonObject);


}
