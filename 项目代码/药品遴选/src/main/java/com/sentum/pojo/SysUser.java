package com.sentum.pojo;


import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.Data;

import java.io.Serializable;

/**
 * <p>
 * 用户信息表
 * </p>
 *
 * @author baomidou
 * @since 2022-05-19
 */
@ApiModel(value = "SysUser对象", description = "用户信息表")
@Data
public class SysUser implements Serializable {

    private static final long serialVersionUID = 1L;

    @ApiModelProperty("用户ID")
    private String userId;

    @ApiModelProperty("登录账号")
    private String loginName = "";

    @ApiModelProperty("用户昵称")
    private String userName = "";

    @ApiModelProperty("用户类型（00系统用户）")
    private Integer userType;

    @ApiModelProperty("用户邮箱")
    private String email = "";

    @ApiModelProperty("手机号码")
    private String phonenumber = "";

    @ApiModelProperty("头像路径")
    private String avatar = "";

    @ApiModelProperty("密码")
    private String password = "";

    @ApiModelProperty("盐加密")
    private String salt = "";

    @ApiModelProperty("帐号状态（0正常 1停用）")
    private String status = "";

    @ApiModelProperty("创建时间")
    private String createTime ;

    @ApiModelProperty("更新时间")
    private String updateTime;

    @ApiModelProperty("备注")
    private String remark = "";

    @ApiModelProperty("文件服务器路径前缀")
    private Integer filePath;

    @ApiModelProperty("部门名称")
    private String deptName = "";

    @ApiModelProperty("微信ID")
    private String weichatId = "";

    @ApiModelProperty("科室")
    private String office = "";

    @ApiModelProperty("出生日期")
    private String birthday = "";

    @ApiModelProperty("职称")
    private String title = "";

}
