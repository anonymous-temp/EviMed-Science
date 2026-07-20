package com.sentum.evidencecomprehensive.feign;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.MongoLiterature;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;

/**
 * Description:
 */
@Component
@FeignClient("fine-screen")
public interface FineScreenFeign {

    @GetMapping("/FineScreenController/paper")
    MongoLiterature paper(@RequestParam("id") String id);

    /**
     * 文献/指南混合检索
     //* @param screenId 检索id（用于记录混合初筛和精筛得到的文献id的集合）
     //* @param searchQuery 检索条件的一句话（picos检索需要自行拼接）
     //* @param query es检索的query
     //* @param type 1-混合初筛；2-混合精筛（调用模型）
     //* @param language 数组，其中元素1-中文、2-英文（指南检索可以传值null）
     //* @param status 1-文献、2-指南
     * @return 初筛/精筛后的id
     */
    @PostMapping("/FineScreenController/mix-search/paper-mix")
    List<String> paperMix(@RequestBody JSONObject dataJason);


    @GetMapping("/FineScreenController/mix-search/get-blocks")
    JSONObject getBlocks(@RequestParam("screenId") String screenId);

    @PostMapping("/FineScreenController/mix-search/get-maxSimilar-block")
    String getMaxSimilarBlock(@RequestBody JSONObject data);

    @GetMapping("/FineScreenController/transSummaryAndTitle")
    JSONObject transSummaryAndTitle(@RequestParam("id") String id);

    @PostMapping("/FineScreenController/deepl")
    String deepl(@RequestBody JSONObject dataJson);
}
