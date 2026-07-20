package com.sentum.controller;

import com.sentum.pojo.vo.DataResult;
import com.sentum.service.LxGptService;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Slf4j
@Api(tags = "快速综合评价GPT API")
@RestController
@RequestMapping("/evaluation-api")
public class LxGptController {
    @Autowired
    LxGptService lxGptSercvice;

    @ApiOperation(value = "获取计算过程", notes = "获取计算过程")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "id", required = true),
    })
    @GetMapping("/lxgpt/process")
    public DataResult process(@RequestParam String id, @RequestParam int step){
       return this.lxGptSercvice.getProcess(id, step);
    }
}
