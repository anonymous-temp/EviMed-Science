package com.sentum.evidencecomprehensive.controller;

import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.service.FineScreenService;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Description:
 * DateTime: 2024/4/12
 */
@Slf4j
@Api
@RestController
@RequestMapping("/evidence-api/Fine-Screen-api")
public class FineScreenController {

    @Autowired
    private FineScreenService fineScreenService;

    @ApiOperation(value = "通过用户输入的词获得联想词的操作",notes = "getAssociationalWord")
    @ApiImplicitParam(name = "word",value = "用户输入的词")
    @GetMapping("/getAssociationalWord")
    public DataResult getAssociationalWord(String word){
        return DataResult.data(fineScreenService.getAssociationalWord(word));
    }
}
