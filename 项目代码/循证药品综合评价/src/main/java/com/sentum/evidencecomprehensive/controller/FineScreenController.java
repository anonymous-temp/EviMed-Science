package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.service.FineScreenService;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Description:
 * DateTime: 2024/4/12
 */
@Slf4j
@Api(tags = "联想词页面API")
@RestController
@RequestMapping("/evidence-api-based/Fine-Screen-api")
public class FineScreenController {

    @Autowired
    private FineScreenService fineScreenService;

    @ApiOperation(value = "通过用户输入的词获得联想词的操作",notes = "getAssociationalWord")
    @ApiImplicitParam(name = "word",value = "用户输入的词")
    @GetMapping("/getAssociationalWord")
    public DataResult getAssociationalWord(String word){
        return DataResult.data(fineScreenService.getAssociationalWord(word));
    }

    @ApiOperation(value = "英文文献翻译",notes = "transSummaryAndTitle")
    @ApiImplicitParam(name = "id",value = "文献id")
    @GetMapping("/transSummaryAndTitle")
    public JSONObject transSummaryAndTitle(@RequestParam("id") String id){
        return fineScreenService.transSummaryAndTitle(id);
    }
}
