package com.sentum.feign;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.google.common.collect.Multimap;
import com.sentum.pojo.MongoLiterature;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.util.MultiValueMap;
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

        @PostMapping("/FineScreenController/deepl")
        String deepl(@RequestBody JSONObject jsonObject);

    @PostMapping("/FineScreenController/mix-search/paper-mix")
    List<String> mixSearch(@RequestBody JSONObject jsonObject);

    @GetMapping("/FineScreenController/mix-search/get-blocks")
    JSONObject getBlocks(@RequestParam("screenId") String screenId);

    @GetMapping("/FineScreenController/getSynonyms")
    JSONObject getSynonyms(@RequestParam("word") String word);
    /**
     * 根据截取的数据获取最相关的文本块
     */
    @PostMapping("/FineScreenController/mix-search/get-maxSimilar-block")
    String getMaxSimilarBlock(@RequestBody JSONObject data);

    @GetMapping("/FineScreenController/paper")
    MongoLiterature paper(@RequestParam("id") String id);

}
