package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.vo.req.HTASearchRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.service.HtaService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * Description: HTA部分
 */

@Api(tags = "HTA报告页面API")
@Slf4j
@RestController
@RequestMapping("/evidence-api-based/hta-api")
public class HtaController {
    @Autowired
    public HtaService htaService;
    
    @GetMapping("/get/initial")
    @ApiOperation("hta报告栏框初始数据获取")
    @ApiImplicitParam(name = "id", value = "检索id", readOnly = true)
    public DataResult getInitialData(String id, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(htaService.getInitialData(id, userId));
    }
    
    @PostMapping("/list")
    @ApiOperation(value = "hta报告list列表获取")
    public DataResult list(@RequestBody HTASearchRequest htaSearchRequest, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(htaService.list(htaSearchRequest, userId));
    }

    @ApiOperation(value = "操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）", notes = "operate")
    @PostMapping("/operate")
    public DataResult operate(@RequestBody OperateRequest OperateRequest, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(htaService.operate(OperateRequest, userId));
    }
    
    @PostMapping ("/collect/get")
    @ApiOperation(value = "获取我的hta报告收藏")
    public DataResult getCollect(@RequestBody HTASearchRequest htaSearchRequest, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(htaService.getCollect(htaSearchRequest, userId));
    }
    
    @ApiOperation(value = "获取pdf的base64")
    @GetMapping("/getPdfBase64")
    public DataResult getPdfBase64(String id) {
        return DataResult.data(htaService.getPdfBase64(id));
    }
}
