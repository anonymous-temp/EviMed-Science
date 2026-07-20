package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.dto.SafeInfoDto;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.service.AdverseService;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.Instant;

@Slf4j
@Api(tags = "药品不良反应页面相关API")
@RestController
@RequestMapping("/evidence-api/adverse-api")
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
    public DataResult indication(@RequestBody SafeInfoDto safeInfoDto) {
        return DataResult.data(adverseService.indication(safeInfoDto));
    }


    @ApiOperation(value = "药品安全性分析-获取适应症数据", notes = "indication")
    @PostMapping("/indication-jd")
    public DataResult indicationJd(@RequestBody SafeInfoDto safeInfoDto) {
        return DataResult.data(adverseService.indicationJd(safeInfoDto));
    }

    @ApiOperation(value = "药品安全性分析-获取图表数据", notes = "drug-safe-info")
    @PostMapping("/drug-safe-info")
    public DataResult drugSafeInfo(@RequestBody SafeInfoDto safeInfoDto) {
        return DataResult.data(adverseService.drugSafeInfo(safeInfoDto, new Condition()));
    }


    @ApiOperation(value = "药品安全性分析-获取图表数据", notes = "drug-safe-info")
    @PostMapping("/drug-safe-info-jd")
    public DataResult drugSafeInfoJd(@RequestBody SafeInfoDto safeInfoDto) {
        return DataResult.data(adverseService.drugSafeInfoJd(safeInfoDto));
    }

    @ApiOperation(value = "药品安全性分析-获取图表数据", notes = "drug-safe-info-zx")
    @PostMapping("/drug-safe-info-zx")
    public JSONObject drugSafeInfoZx(@RequestBody Condition condition) {
        Instant start = Instant.now(); // 记录方法开始执行的时间
        JSONObject result = adverseService.drugSafeInfo(new SafeInfoDto(), condition);
        Instant end = Instant.now(); // 记录方法结束执行的时间
        long timeElapsed = Duration.between(start, end).toMillis(); // 计算执行时间，单位为毫秒
        System.out.println("drugSafeInfoZx method took " + timeElapsed + " ms."); // 输出执行时间
        return result;
    }




    @ApiOperation(value = "药品安全性分析-疾病数量", notes = "ptCount")
    @GetMapping("/ptCount")
    public DataResult ptCount() {
        return DataResult.data(adverseService.ptCount());
    }


}
