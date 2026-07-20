package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.dto.GuideOperateDto;
import com.sentum.evidencecomprehensive.pojo.dto.GuideSearchDto;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.pojo.vo.req.GuideInitialRequest;
import com.sentum.evidencecomprehensive.service.GuideService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.validation.Valid;

@Slf4j
@Api(tags = "指南页面相关API")
@RestController
@RequestMapping("/evidence-api/guide-api")
public class GuideController {
    @Autowired
    private GuideService guideService;

    @ApiOperation(value = "获取指南发布者列表", notes = "author-list")
    @ApiImplicitParam(name = "id", value = "检索id", required = true)
    @PostMapping("/author-list")
    public DataResult authorList(@Valid @RequestBody GuideInitialRequest guideInitialRequest) {
        return DataResult.data(guideService.authorList(guideInitialRequest));
    }

    @ApiOperation(value = "检索指南列表", notes = "list")
    @PostMapping("/list")
    public DataResult list(@RequestBody GuideSearchDto guideSearchDto, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(guideService.list(guideSearchDto, userId));
    }

    @ApiOperation(value = "操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）", notes = "list")
    @PostMapping("/operate")
    public DataResult operate(@RequestBody GuideOperateDto guideOperateDto, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(guideService.operate(guideOperateDto, userId));
    }

    @ApiOperation(value = "展示用户收藏的指南列表数据", notes = "show-guide-collect")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "searchWord", value = "用户检索词"),
            @ApiImplicitParam(name = "pageSize", value = "每页大小", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前页", required = true)
    })
    @GetMapping("/show-guide-collect")
    public DataResult showGuideCollect(HttpServletRequest request, HttpServletResponse response, String searchWord, @RequestParam(defaultValue = "1") Integer pageSize, @RequestParam(defaultValue = "10")  Integer pageNum) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(guideService.showGuideCollect(userId, searchWord, pageSize, pageNum));
    }
}
