package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.domain.vo.req.EditMultiContentRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.GenTemplateRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.SaveContentRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.SaveTemplateRequest;
import com.sentum.evidencecomprehensive.service.ReportNewService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.*;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * @Description: 新版报告controller
 */

@Slf4j
@Api(tags = "报告页面相关API")
@RestController
@RequestMapping("/evidence-api-based/report-api")
public class ReportNewController {
    @Autowired
    private ReportNewService reportNewService;

    @ApiOperation(value = "app 的报告生成", notes = "create")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    })
    @GetMapping("/template/app")
    public DataResult createEvidenceBasedReportApp(@RequestParam(value = "id") String id, @RequestParam(value = "verifyToken", required = false, defaultValue = "null") String verifyToken, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            reportNewService.createReportTemplateApp(id, verifyToken, token, userId, request);
        } catch (Exception e) {
            response.setStatus(401);
        }
        return DataResult.ok();
    }

    @ApiOperation(value = "大纲生成", notes = "create")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    })
    @GetMapping("/template")
    public DataResult createEvidenceBasedReport(@RequestParam(value = "id") String id, @RequestParam(value = "verifyToken", required = false, defaultValue = "null") String verifyToken, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            return DataResult.data(reportNewService.createReportTemplate(id, verifyToken, userId, request));
        } catch (Exception e) {
            response.setStatus(401);
        }
        return DataResult.ok();
    }

    @ApiOperation(value = "大纲保存", notes = "create")
    @PostMapping("/save-template")
    public DataResult saveTemplate(@RequestBody SaveTemplateRequest saveTemplateRequest) {
        reportNewService.saveTemplate(saveTemplateRequest);
        return DataResult.ok();
    }

    @ApiOperation(value = "依据大纲内容生成", notes = "create")
    @PostMapping("/template")
    public void fillTemplate(@RequestBody GenTemplateRequest genTemplateRequest, HttpServletRequest request, HttpServletResponse response) {
        response.setContentType("text/event-stream");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control","no-cache");
        response.setHeader("Connection", "keep-alive");
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            reportNewService.fillTemplate(genTemplateRequest, userId, token, response);
        } catch (Exception e) {
            response.setStatus(401);
        }
    }

    @ApiOperation(value = "内容保存", notes = "save")
    @PostMapping("/save-content")
    public DataResult saveContent(@RequestBody SaveContentRequest saveContentRequest) {
        reportNewService.saveContent(saveContentRequest);
        return DataResult.ok();
    }


    @ApiOperation(value = "报告右侧信息接口", notes = "report-right")
    @GetMapping("/report-right")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    })
    public DataResult searchReportRight(String id) {
        return DataResult.data(reportNewService.searchReportRight(id));
    }

    @ApiOperation(value = "点选，是否点转后台执行", notes = "report-right")
    @GetMapping("/click")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true),
            @ApiImplicitParam(name = "clickMode", value = "点选方式，0后台，1当前页面", required = true)
    })
    public DataResult executeMode(String id, String clickMode, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            reportNewService.executeMode(id, clickMode, userId, token);
        } catch (Exception e) {
            response.setStatus(401);
        }
        return DataResult.ok();
    }
    
    @ApiOperation(value = "查询 点选报告的状态", notes = "click-status")
    @GetMapping("/click-status")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "pageSize", value = "每页大小", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前所在页", required = true)
    })
    public DataResult searchClickStatus(@RequestParam(value = "pageSize", defaultValue = "10") Integer pageSize, @RequestParam(value = "pageNum", defaultValue = "1") Integer pageNum, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        String token = request.getHeader("token");
        Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);

        if (redis == null) {
            throw new IllegalArgumentException("Token is invalid or expired");
        }

        JSONObject redisMap = JSONObject.parseObject(redis.toString());
        userId = redisMap.getLong("userId");
        
        return DataResult.data(reportNewService.searchClickStatus(userId, pageSize, pageNum));
    }

    @ApiOperation(value = "删除 点选报告", notes = "delete")
    @GetMapping("/delete")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true),
            @ApiImplicitParam(name = "allD", value = "全部删除", required = true)
    })
    public DataResult searchClickStatus(@RequestParam(value = "id") String id, @RequestParam(value = "allD", defaultValue = "false") String allD, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            reportNewService.deleteClickReport(userId, id, allD);
        } catch (Exception e) {
            response.setStatus(401);
        }
        return DataResult.ok();
    }

    @ApiOperation(value = "更新 点选报告 状态", notes = "delete")
    @GetMapping("/update")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    })
    public DataResult updateClickStatus(@RequestParam(value = "id") String id, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            return DataResult.data(reportNewService.updateClickStatus(userId, id));
        } catch (Exception e) {
            response.setStatus(401);
        }
        return DataResult.ok();
    }


    @ApiOperation(value = "word下载", notes = "download")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/download/new")
    public void downloadEvidenceBasedReportWord(@RequestParam("id") String id, @RequestParam(defaultValue = "app") String source, HttpServletResponse response) {
        reportNewService.downloadWord(id, source, response);
    }

    @ApiOperation(value = "编辑-内容修改", notes = "create")
    @PostMapping("/edit/multi")
    public void editMultiContent(@RequestBody EditMultiContentRequest editMultiContentRequest, HttpServletRequest request, HttpServletResponse response) {
        response.setContentType("text/event-stream");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control","no-cache");
        response.setHeader("Connection", "keep-alive");
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
            reportNewService.editMultiContent(editMultiContentRequest, userId, token, response);
        } catch (Exception e) {
            response.setStatus(401);
        }
    }
}
