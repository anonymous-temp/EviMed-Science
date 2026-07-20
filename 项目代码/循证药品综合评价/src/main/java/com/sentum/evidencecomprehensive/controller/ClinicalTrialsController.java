package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.vo.req.ClinicalTrialsSearchRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.ThreeClinicalTrialsRequest;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.service.ClinicalTrialsService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@Slf4j
@Api(tags = "临床试验页面相关API")
@RestController
@RequestMapping("/evidence-api-based/clinical-trials-api")
public class ClinicalTrialsController {
    @Autowired
    private ClinicalTrialsService clinicalTrialsService;

    @ApiOperation(value = "检索文献列表", notes = "list")
    @PostMapping("/list")
    public DataResult list(@RequestBody ClinicalTrialsSearchRequest searchDto, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(clinicalTrialsService.list(searchDto, userId, 1));
    }

    @ApiOperation(value = "第三个临床试验检索列表", notes = "three-list")
    @PostMapping("/three-list")
    public DataResult threeList(@RequestBody ThreeClinicalTrialsRequest searchDto, HttpServletRequest request, HttpServletResponse response) {
//        long userId;
//        try {
//            String token = request.getHeader("token");
//            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
//            assert redis != null;
//            JSONObject redisMap = JSONObject.parseObject(redis.toString());
//            userId = redisMap.getLong("userId");
//        } catch (Exception e) {
//            response.setStatus(401);
//            return DataResult.error(401, "token can't null or empty string");
//        }
        return DataResult.data(clinicalTrialsService.threeList(searchDto));
    }

    @ApiOperation(value = "操作/批量操作（纳入/排除/取消排除）", notes = "operate")
    @PostMapping("/operate")
    public DataResult operate(@RequestBody OperateRequest operateDto, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(clinicalTrialsService.operate(operateDto, userId));
    }
}
