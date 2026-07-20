package com.sentum.evidencecomprehensive.controller;

import com.sentum.evidencecomprehensive.domain.vo.req.SafeInfoRequest;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.service.AdverseService;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

@Slf4j
@Api(tags = "药品不良反应页面相关API")
@RestController
@RequestMapping("/evidence-api-based/adverse-api")
public class AdverseController {
    @Autowired
    private AdverseService adverseService;

    @ApiOperation(value = "查询用户本次检索的全部药品名称", notes = "info")
    @ApiImplicitParam(name = "id", value = "检索id", required = true)
    @GetMapping("/info")
    public DataResult getDrugName(String id) {
        return DataResult.data(adverseService.info(id));
    }

    @ApiOperation(value = "药品安全性分析-获取适应症数据", notes = "indication")
    @PostMapping("/indication")
    public DataResult indication(@RequestBody SafeInfoRequest safeInfoRequest) {
        return DataResult.data(adverseService.indication(safeInfoRequest));
    }

    @ApiOperation(value = "药品安全性分析-获取图表数据", notes = "drug-safe-info")
    @PostMapping("/drug-safe-info")
    public DataResult drugSafeInfo(@RequestBody SafeInfoRequest safeInfoRequest) {
        return DataResult.data(adverseService.drugSafeInfo(safeInfoRequest));
    }
}
