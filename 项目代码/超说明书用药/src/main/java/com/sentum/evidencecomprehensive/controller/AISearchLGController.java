package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.service.AISearchLGService;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.Collections;


/**
 * Description: AI检索
 */

@Api(tags = "Ai检索 APi")
@Slf4j
@RestController
@RequestMapping("/evidence-api/ai-api")
public class AISearchLGController {
    
    @Autowired
    private AISearchLGService aiSearchLGService;

    @ApiOperation(value = "AI search 指南文献")
    @GetMapping("/lg")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题 id", required = true)
    })
    public DataResult aiSearchLg(@RequestParam(value = "id") String id) {
        return DataResult.data(aiSearchLGService.searchLG(id));
    }

    @GetMapping("/cb")
    public DataResult aiSearchCB(@RequestParam(value = "drugName", required = false) String drugName) {
        return DataResult.data(aiSearchLGService.searchCB(Collections.singletonList(drugName), Collections.singletonList("")));
    }

    /**
     * 疾病去修饰词
     */
    @PostMapping("/split")
    public DataResult aiSplitDisease(@RequestBody JSONObject param) {
        return DataResult.data(aiSearchLGService.aiSplitDisease(param));
    }

}
