package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.service.MailService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
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

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@Slf4j
@Api(tags = "站内信页面相关API")
@RestController
@RequestMapping("/evidence-api/mail-api")
public class MailController {
    @Autowired
    private MailService mailService;

    @ApiOperation(value = "获取站内信列表", notes = "list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "pageSize", value = "每页大小", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前页数", required = true)
    })
    @GetMapping("/list")
    public DataResult list(HttpServletRequest request, HttpServletResponse response, @RequestParam(defaultValue = "10") Integer pageSize, @RequestParam(defaultValue = "1") Integer pageNum) {
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
        return DataResult.data(mailService.list(userId, pageSize, pageNum));
    }

    @ApiOperation(value = "用户读取站内信", notes = "read")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "站内信id", required = true),
            @ApiImplicitParam(name = "allRead", value = "全部已读，true 是，false 否", required = true)
    })
    @GetMapping("/read")
    public DataResult read(String id, Boolean allRead, HttpServletRequest request, HttpServletResponse response) {
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
        Boolean read = mailService.read(id, allRead, userId);
        if (read) {
            return DataResult.ok();
        }else {
            return DataResult.error("读取失败");
        }
    }

}
