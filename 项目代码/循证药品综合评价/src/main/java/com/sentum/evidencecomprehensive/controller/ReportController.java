package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.domain.vo.InitialRequestVo;
import com.sentum.evidencecomprehensive.service.ReportService;
import com.sentum.evidencecomprehensive.service.WordService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import net.bytebuddy.implementation.bind.annotation.Default;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * @Description: 报告生成接口
 */

@Slf4j
@Api(tags = "报告页面相关API")
@RestController
@RequestMapping("/evidence-api-based/report-api")
public class ReportController {
    @Autowired
    private ReportService reportService;
    @Autowired
    private WordService wordService;

    @PostMapping("getInitialData")
    @ApiOperation(value = "首页弹框", notes = "getInitialData")
    public DataResult getInitialData(@RequestBody InitialRequestVo initialRequestVo,
                                     HttpServletRequest request, 
                                     HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return reportService.getInitialData(initialRequestVo, userId);
    }
    
    @ApiOperation(value = "生成决策报告", notes = "create")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true),  
            @ApiImplicitParam(name = "update", value = "是否更新", required = true, defaultValue = "false"),     
            @ApiImplicitParam(name = "verifyToken", value = "验签 token", required = false, defaultValue = "null")
    })
    @GetMapping("/create")
    public DataResult createEvidenceBasedReport(@RequestParam("id") String id, @RequestParam("update") boolean update, @RequestParam(value = "verifyToken", required = false, defaultValue = "null") String verifyToken, @RequestParam(defaultValue = "1") String type, @RequestParam(defaultValue = "app") String source, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return reportService.createEvidenceBasedReport(id, update, userId, type, source, verifyToken, request);
    }

    @ApiOperation(value = "生成 token", notes = "create")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    })
    @GetMapping("/token")
    public DataResult createVerityToken(@RequestParam("id") String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        String token = reportService.createToken(id, userId, request);
        return DataResult.data(token);
    }

    @ApiOperation(value = "决策报告word下载", notes = "download")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/download")
    public void downloadEvidenceBasedReportWord(@RequestParam("id") String id, @RequestParam(defaultValue = "app") String source, HttpServletResponse response) {
        wordService.downloadEvidenceBasedReportWord(id, source, response);
    }

    @ApiOperation(value = "查看报告", notes = "show")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/show")
    public DataResult show(String id) {
        return DataResult.data(reportService.show(id));
    }

    @ApiOperation(value = "默认纳入", notes = "include")
    @ApiImplicitParam(name = "id", value = "课题id", required = true)
    @GetMapping("/include")
    public DataResult include(String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        //reportService.include(id, userId);
        return DataResult.ok();
    }
}
