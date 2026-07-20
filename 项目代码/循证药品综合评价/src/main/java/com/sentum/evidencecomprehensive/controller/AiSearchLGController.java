package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.service.AiSearchLGService;
import io.swagger.annotations.Api;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;


/**
 * Description: AI检索
 */

@Api(tags = "Ai检索 APi")
@Slf4j
@RestController
@RequestMapping("/evidence-api-based/ai-api")
public class AiSearchLGController {
    
    @Autowired
    private AiSearchLGService aiSearchLGService;

    @PostMapping("/split")
    public DataResult aiSplitDisease(@RequestBody JSONObject json) {
        return DataResult.data(aiSearchLGService.aiSplitDisease(json));
    }

}
