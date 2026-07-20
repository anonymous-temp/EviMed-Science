package com.sentum.controller;

import com.sentum.pojo.vo.DataResult;
import com.sentum.service.InstructionSearch;
import io.swagger.annotations.Api;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Slf4j
@Api(tags = "查询药品说明书")
@RestController
@RequestMapping("/Instruction-api")
public class InstructionSearchController {
    @Autowired
    private InstructionSearch instructionSearch;

    @GetMapping("/instructionSearch")
    public DataResult instructionSearch(String str) {
        return  DataResult.data(instructionSearch.getInstruction(str));
    }

}
