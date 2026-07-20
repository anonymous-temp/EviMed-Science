package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.pojo.vo.QuestionUpdateVo;
import com.sentum.evidencecomprehensive.service.QuestionService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.util.List;

@Slf4j
@Api(tags = "课题页面相关API")
@RestController
@RequestMapping("/evidence-api/question-api")
public class QuestionController {
    @Autowired
    private QuestionService questionService;

    @ApiOperation(value = "修改课题名称", notes = "update-name")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true),
            @ApiImplicitParam(name = "name", value = "修改后的课题名称", required = true)
    })
    @PostMapping("/update-name")
    public DataResult updateName(@RequestBody QuestionUpdateVo questionUpdateVo) {
        Boolean aBoolean = questionService.updateName(questionUpdateVo);
        if (aBoolean){
            return DataResult.ok("修改成功");
        }else {
            return DataResult.error("修改失败");
        }
    }

    @ApiOperation(value = "查询课题名称", notes = "name")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/name")
    public DataResult getName(String id) {
        String name = questionService.getName(id);
        if (StringUtils.isNotBlank(name)){
            return DataResult.data(name);
        }else {
            return DataResult.error("课题名称获取失败");
        }
    }

    @ApiOperation(value = "查询课题列表", notes = "list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "type", value = "1-全部课题；2-我的课题；3-收藏课题；4-分享课题，默认1全部", required = true),
            @ApiImplicitParam(name = "search", value = "用户输入的检索词"),
            @ApiImplicitParam(name = "pageSize", value = "每页大小，默认10", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前页，默认1", required = true),
            @ApiImplicitParam(name = "sortType", value = "排序类型，1-创建时间排序，2-最后操作时间排序，0-默认排序", required = true),
            @ApiImplicitParam(name = "direction", value = "排序方向，1-正序，2-倒叙", required = true)
    })
    @GetMapping("/list")
    public DataResult list(@RequestParam(defaultValue = "1") Integer type, String search, @RequestParam(defaultValue = "10") Integer pageSize, @RequestParam(defaultValue = "1") Integer pageNum, @RequestParam(defaultValue = "0") Integer sortType, Integer direction, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(questionService.list(userId, type, search, pageSize, pageNum, sortType, direction, request));
    }

    @ApiOperation(value = "批量/单个删除课题数据", notes = "delete")
    @ApiImplicitParam(name = "ids", value = "课题id的集合", required = true)
    @GetMapping("/delete")
    public DataResult delete(@RequestParam("ids") List<String> ids) {
        Boolean delete = questionService.delete(ids);
        if (delete) {
            return DataResult.ok();
        } else {
            return DataResult.error("删除失败");
        }
    }

    @ApiOperation(value = "收藏/取消收藏课题", notes = "collect")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "ids", value = "课题id的集合", required = true),
            @ApiImplicitParam(name = "status", value = "1-收藏；0-取消收藏", required = true)
    })
    @GetMapping("/collect")
    public DataResult collect(@RequestParam("ids") List<String> ids, Integer status) {
        Boolean collect = questionService.collect(ids, status);
        if (collect) {
            return DataResult.ok();
        } else {
            return DataResult.error("收藏/取消收藏失败");
        }
    }

    @ApiOperation(value = "查询当前课题的历史记录课题", notes = "history")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/history")
    public DataResult history(String id) {
        return DataResult.data(questionService.history(id));
    }

    @ApiOperation(value = "创建课题分享链接", notes = "create-share-url")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/create-share-url")
    public DataResult createShareUrl(String id, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(questionService.createShareUrl(id, userId));
    }

    @ApiOperation(value = "根据链接生成课题", notes = "share")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "tarId", value = "来源课题id（检索id）", required = true),
            @ApiImplicitParam(name = "tarUserId", value = "来源的作者id", required = true)
    })
    @GetMapping("/share")
    public DataResult share(String tarId, Long tarUserId, HttpServletRequest request, HttpServletResponse response) {
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
        if (userId == tarUserId) {
            return DataResult.error("分享链接暂不支持自己分享给自己");
        }
        Boolean share = questionService.share(tarId, tarUserId, userId, request);
        if (share) {
            return DataResult.ok();
        }
        return DataResult.error("分享链接已失效");
    }

    @ApiOperation(value = "根据课题id判断当前课题跳转的页面（1-检索页面；2-证据列表页面）；该方法也可以判断当前课题是否有报告返回2时有报告", notes = "determine")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/determine")
    public DataResult determine(String id) {
        return DataResult.data(questionService.determine(id));
    }
}
