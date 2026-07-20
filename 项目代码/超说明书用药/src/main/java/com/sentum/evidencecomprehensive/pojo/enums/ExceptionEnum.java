package com.sentum.evidencecomprehensive.pojo.enums;

/**
 * 系统异常枚举类
 */
public enum ExceptionEnum {
    /**
     * 成功.: 200 (因为http中的状态码200一般都是表示成功)
     */
    SUCCESS(200, "成功"),

    /**
     * 系统异常. ErrorCode : -1
     */
    SystemException(-1, "系统异常"),

    /**
     * 未知异常. ErrorCode : 01
     */
    UnknownException(01, "未知异常"),

    /**
     * 服务异常. ErrorCode : 02
     */
    ServiceException(02, "服务繁忙"),

    /**
     * 参数验证错误. ErrorCode : 06
     */
    ParamException(03, "参数验证错误"),

    /**
     * 文件上传权限认证未通过
     */
    AuthorationException(07,"权限认证异常"),


    // ############################# 服务错误2xx ##############################
    MODEL_FORMAT_ERROR(201, "自定义检索式格式不正确！！！"),
    
    // ############################# 用户登录1xx ##############################
    AccountAbsentException(102,"账号不存在，请进行注册！"),
    PassWordErrorException(103,"密码错误！"),
    PhoneNumberIsNullOrBlankException(104,"手机号不能为空！"),
    LoginException(105,"登录失败！"),
    VCodeIsNullOrBlankException(106,"验证码不能空！"),
    VCodeErrorException(107,"验证码错误！"),
    PhoneNumberOrMailIsNullOrBlankException(108,"请输入手机号/邮箱不能为空！"),
    EmailExistException(109,"邮箱已被注册！"),
    PhoneNumberChangeException(110,"手机号已被注册！"),
    DeptNameLengthException(111,"部门名称长度超出限制！"),
    DoublePasswordNotSameException(112,"密码不一致！"),
    SessionTimeOutException(113,"登录状态已过期，请重新登陆！"),
    PhoneNumberInErrorException(114,"手机号输入错误！"),
    PhoneVcodeExpireException(115,"验证码已过期！请重新获取验证码！"),
    OldPwdErrorException(116,"原密码输入不正确，请重新输入！");
    

    private final Integer code;
    private final String msg;

    ExceptionEnum(Integer code, String msg){
        this.code = code;
        this.msg = msg;
    }

    public Integer getCode(){
        return code;
    }

    public String getMsg(){
        return msg;
    }
}
