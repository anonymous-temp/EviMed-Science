package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.service.SuperManualReportService;
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

/**
 * 超说明书报告页面相关API
 * @author zgm
 */
@Slf4j
@Api(tags = "超说明书报告页面相关API")
@RestController
@RequestMapping("/evidence-api/super-manual-api")
public class SuperManualReportController {
    
    @Autowired
    private SuperManualReportService superManualReportService;

    @ApiOperation(value = "查看超说明书报告", notes = "show")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/show")
    public DataResult show(String id) {
        return DataResult.data(superManualReportService.show(id));
    }

    @ApiOperation(value = "保存超说明书修改后的报告数据", notes = "change-cache")
    @PostMapping("/change-cache")
    public DataResult changeCache(@RequestBody JSONObject dataJson) {
        boolean b = superManualReportService.changeCache(dataJson);
        if (b) {
            return DataResult.ok();
        } else {
            return DataResult.error("修改保存失败！");
        }
    }

    @ApiOperation(value = "默认纳入", notes = "include")
    @ApiImplicitParam(name = "id", value = "课题id", required = true)
    @GetMapping("/include")
    public DataResult include(String id, HttpServletRequest request, HttpServletResponse response) {
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
        superManualReportService.include(id, userId, null);
        return DataResult.ok();
    }


    @ApiOperation(value = "生成超说明书报告", notes = "create")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/createPc")
    public DataResult createPc(@RequestParam("id") String id, @RequestParam(value = "type", defaultValue = "2") String type, @RequestParam(defaultValue = "app") String source, @RequestParam(value = "verifyToken", required = false, defaultValue = "null") String verifyToken, HttpServletRequest request, HttpServletResponse response) {
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
        return DataResult.data(superManualReportService.createPc(id, userId, type, source, verifyToken, request));
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
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        String token = superManualReportService.createToken(id, userId, request);
        return DataResult.data(token);
    }

    @ApiOperation(value = "查看超说明书报告", notes = "show")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/showPc")
    public DataResult showPc(String id) {
        return DataResult.data(superManualReportService.showPc(id));
    }

    @ApiOperation(value = "下载超说明书报告", notes = "download")
    @ApiImplicitParam(name = "id", value = "课题id（检索id）", required = true)
    @GetMapping("/downloadPc")
    public void downloadPc(String id, @RequestParam(defaultValue = "app") String source, HttpServletResponse response) {
        superManualReportService.downloadPc(id, source, response, "");
    }
}
